/**
 * pipeline.ts — the one search implementation.
 *
 * fetch all sources -> normalize -> dedupe -> score eligibility -> filter -> rank
 *
 * Both callers use this and nothing else:
 *   - the `find_jobs` MCP tool (src/index.ts), which formats the result as text
 *   - `GET /api/search` on the dashboard (src/dashboard.ts), which returns JSON
 *
 * Keep it that way: any ranking or filtering change must land here once, not
 * twice.
 */

import { belowSalaryFloor } from "./boards-pl.ts";
import { listDismissedKeys } from "./db.ts";
import { workSignals } from "./workmode.ts";
import { jobKey } from "./jobkey.ts";
import { scoreEligibility, levelRank, type Eligibility } from "./eligibility.ts";
import {
  SEARCH_DEFAULTS,
  TARGET_QUERIES,
  fitTier,
  matchLevel,
  relevanceBoost,
  seniorityBucket,
  stackFit,
} from "./profile.ts";
import {
  DEFAULT_SOURCES,
  PER_PASS_SOURCES,
  dedupeJobs,
  fetchAllSources,
  type Job,
  type SourceName,
  type SourceReport,
} from "./sources.ts";

export type RankedJob = Job & { eligibility: Eligibility };

export type SearchParams = {
  query?: string;
  /**
   * Several searches merged into one ranked list. One keyword cannot cover both
   * "React" work and "AI/LLM" work, and boards match keywords rather than
   * meaning. Overlap is free — everything is deduped before scoring.
   */
  queries?: string[];
  /** Drop jobs above this fit tier (2 = neutral, 3 = wrong/junior/non-engineering). */
  maxFitTier?: number;
  /**
   * Jobs to drop — the "not interested" list, compared by jobKey so a tracking
   * parameter cannot bring a hidden job back. searchForProfile fills this from
   * the database, so a job dismissed in the dashboard also disappears from
   * `find_jobs`. Pass [] to include dismissed jobs again.
   */
  excludeUrls?: string[];
  seniority?: string;
  worldwideOnly?: boolean;
  minSalary?: number;
  sources?: SourceName[];
  /** Drop jobs scored `low`. Default true. */
  onlyEligible?: boolean;
  /** Max jobs returned. Default 20. */
  limit?: number;
  /** Scraped sources: where to search. Defaults to Poland. */
  location?: string;
  /** Scraped sources: only remote postings. */
  remoteOnly?: boolean;
  /** Scraped sources: ignore postings older than this many hours. */
  hoursOld?: number;
  /** LinkedIn: also fetch descriptions (one extra request per job — slow). */
  linkedinDescriptions?: boolean;
};

/** Where jobs were lost between fetching and returning — shown to the user. */
export type SearchCounts = {
  fetched: number;
  deduped: number;
  afterEligibility: number;
  /** After the stack-fit filter (neutral, wrong stack, junior, non-engineering). */
  afterFit: number;
  afterSalary: number;
  returned: number;
  /** Excluded because minSalary was set and the posting publishes no salary. */
  hiddenForUnknownSalary: number;
  /** Excluded as a poor stack fit. */
  hiddenForFit: number;
  /** Excluded because they were dismissed ("not interested"). */
  hiddenForDismissed: number;
  /** Excluded as older than the hoursOld window. */
  hiddenForAge: number;
  /** The searches that produced this list. */
  queries: string[];
};

export type SearchResult = {
  jobs: RankedJob[];
  /** Raw jobs fetched per source. 0 can mean "no matches" OR "skipped" — see reports. */
  sourceCounts: Record<string, number>;
  reports: SourceReport[];
  counts: SearchCounts;
  levelCounts: Record<string, number>;
};

export const DEFAULT_SEARCH_LIMIT = 20;

/** Rank by the job itself before uncertain source metadata. */
export function rankJobs(jobs: RankedJob[]): RankedJob[] {
  return jobs.slice().sort((a, b) => {
    const byFit = fitTier(a) - fitTier(b);
    if (byFit !== 0) return byFit;

    // Published pay under the floor (profile.ts SALARY) goes to the end of its
    // tier: a fit score cannot make INR 1.2M a year (≈4k PLN a month) a top
    // card. Demoted, never hidden — unknown pay is not "below".
    const byPay = Number(belowSalaryFloor(a)) - Number(belowSalaryFloor(b));
    if (byPay !== 0) return byPay;

    const band = (job: RankedJob) => Math.floor(stackFit(job) / 8);
    const byBand = band(b) - band(a);
    if (byBand !== 0) return byBand;

    const bySeniority = seniorityBucket(a) - seniorityBucket(b);
    if (bySeniority !== 0) return bySeniority;

    // The text asks for office days, or for fluent Polish: shown, labelled,
    // and after the roles that do not.
    const friction = (job: RankedJob) =>
      Number(workSignals(job).mode !== null || workSignals(job).polishRequired);
    const byFriction = friction(a) - friction(b);
    if (byFriction !== 0) return byFriction;

    // Eligibility `medium` usually means missing LinkedIn metadata, not a weak
    // professional match, so geography comes after fit and seniority.
    const byLevel = levelRank(a.eligibility.level) - levelRank(b.eligibility.level);
    if (byLevel !== 0) return byLevel;

    const aTime = a.postedAt ? Date.parse(a.postedAt) : 0;
    const bTime = b.postedAt ? Date.parse(b.postedAt) : 0;
    if (bTime !== aTime) return bTime - aTime;

    return relevanceBoost(b) - relevanceBoost(a);
  });
}

/**
 * Oversample hard. Measured against the live feeds, the eligibility filter
 * alone removes ~90% of a text search's Himalayas results, so fetching just
 * `limit` rows returns almost nothing. Three pages costs two extra requests
 * and roughly triples the usable hits.
 *
 * Capped at 200 because that is the most fetchAllSources will pass on: asking
 * for more inflates the number without fetching a single extra row, which
 * matters now that `limit` is a display budget (200) rather than a page size.
 * In practice no board even reaches the cap — a ten-query pass averages ~120
 * rows per query from Indeed, ~90 from LinkedIn — so raising `limit` costs
 * nothing.
 */
function oversample(limit: number): number {
  return Math.min(Math.max(limit * 4, 60), 200);
}

export async function searchJobs(params: SearchParams = {}): Promise<SearchResult> {
  const limit = params.limit ?? DEFAULT_SEARCH_LIMIT;
  const dropLow = params.onlyEligible ?? true;
  const sources: SourceName[] = params.sources?.length ? params.sources : DEFAULT_SOURCES;

  // One query or many: a single query is just a list of one, so the merge path
  // below is the only path and stays exercised.
  const queries =
    params.queries?.length ? params.queries : [params.query ?? ""];

  const common = {
    seniority: params.seniority,
    worldwideOnly: params.worldwideOnly,
    sources,
    limit: oversample(limit),
    location: params.location,
    remoteOnly: params.remoteOnly,
    hoursOld: params.hoursOld,
    linkedinDescriptions: params.linkedinDescriptions,
  };

  // Boards that take no search term are fetched once, not once per query.
  // Their outcome goes first so their copy of a role (with pay) wins dedupe.
  const perPass = sources.filter((source) => PER_PASS_SOURCES.includes(source));
  const perQuery = sources.filter((source) => !PER_PASS_SOURCES.includes(source));
  const outcomes = await Promise.all([
    ...(perPass.length > 0 ? [fetchAllSources({ ...common, sources: perPass })] : []),
    ...(perQuery.length > 0
      ? queries.map((query) =>
          fetchAllSources({ ...common, sources: perQuery, query: query || undefined }),
        )
      : []),
  ]);

  const allJobs = outcomes.flatMap((outcome) => outcome.jobs);

  // Sum the per-source counts across queries so the UI reports real totals.
  const reportBySource = new Map<SourceName, SourceReport>();
  for (const outcome of outcomes) {
    for (const report of outcome.reports) {
      const existing = reportBySource.get(report.source);
      if (!existing) {
        reportBySource.set(report.source, { ...report });
        continue;
      }
      existing.count += report.count;
      // Keep the first failure visible rather than letting a later success hide it.
      existing.skipped = existing.skipped ?? report.skipped;
    }
  }
  const outcome = { jobs: allJobs, reports: [...reportBySource.values()] };

  const deduped = dedupeJobs(outcome.jobs);

  // Dismissed jobs go first: no point scoring what will never be shown.
  const excluded = new Set((params.excludeUrls ?? []).map(jobKey));
  const kept =
    excluded.size === 0 ? deduped : deduped.filter((job) => !excluded.has(jobKey(job.url)));
  const hiddenForDismissed = deduped.length - kept.length;

  // The window is enforced here, for every caller. hoursOld only reaches the
  // scraped boards, and Himalayas alone returned month-and-a-half-old rows;
  // before this only the dashboard page dropped them, so find_jobs and the
  // screen script still saw them. Undated postings are kept: not provably old.
  const hoursOld = params.hoursOld;
  let hiddenForAge = 0;
  const fresh =
    hoursOld === undefined
      ? kept
      : kept.filter((job) => {
          if (!job.postedAt || Date.parse(job.postedAt) >= Date.now() - hoursOld * 3_600_000) {
            return true;
          }
          hiddenForAge++;
          return false;
        });

  const scored: RankedJob[] = fresh.map((job) => ({
    ...job,
    eligibility: scoreEligibility(job),
  }));

  const afterEligibility = dropLow
    ? scored.filter((job) => job.eligibility.level !== "low")
    : scored;

  // Fit filter: with a one-button feed there is no reason to render a .NET role
  // or an internship at all. Ranking them last only helped while a human was
  // typing the query and could judge for themselves.
  let hiddenForFit = 0;
  const maxTier = params.maxFitTier;
  const afterFit =
    maxTier === undefined
      ? afterEligibility
      : afterEligibility.filter((job) => {
          if (fitTier(job) <= maxTier) return true;
          hiddenForFit++;
          return false;
        });

  // Strict on purpose: a posting with no published salary cannot be shown to
  // meet the floor, so it is excluded — but we count how many that hid.
  let hiddenForUnknownSalary = 0;
  const minSalary = params.minSalary;
  const afterSalary =
    minSalary === undefined
      ? afterFit
      : afterFit.filter((job) => {
          const best = job.salaryMax ?? job.salaryMin;
          if (best === null) {
            hiddenForUnknownSalary++;
            return false;
          }
          return best >= minSalary;
        });

  const ranked = rankJobs(afterSalary);

  const jobs = ranked.slice(0, limit);

  const sourceCounts: Record<string, number> = {};
  for (const report of outcome.reports) sourceCounts[report.source] = report.count;

  const levelCounts: Record<string, number> = {};
  for (const job of jobs) {
    levelCounts[job.eligibility.level] = (levelCounts[job.eligibility.level] ?? 0) + 1;
  }

  return {
    jobs,
    sourceCounts,
    reports: outcome.reports,
    levelCounts,
    counts: {
      fetched: outcome.jobs.length,
      deduped: deduped.length,
      afterEligibility: afterEligibility.length,
      afterFit: afterFit.length,
      afterSalary: afterSalary.length,
      returned: jobs.length,
      hiddenForUnknownSalary,
      hiddenForFit,
      hiddenForDismissed,
      hiddenForAge,
      queries: queries.filter((query) => query.length > 0),
    },
  };
}

/**
 * The profile-driven search: no arguments, everything comes from profile.ts.
 *
 * This is what the dashboard's Refresh button and a bare `find_jobs` call use.
 * The stack does not change between runs, so there is nothing to type — edit
 * profile.ts to change what gets found.
 *
 * Overrides are accepted for the rare one-off (a different city, a wider net).
 */
export function searchForProfile(overrides: SearchParams = {}): Promise<SearchResult> {
  // Read the "not interested" list here, so every caller of the profile search
  // — dashboard and find_jobs — honours it without having to remember.
  const dismissed = listDismissedKeys();

  // Strip undefined before spreading. A caller forwarding optional arguments
  // passes `{ limit: undefined, remoteOnly: undefined, ... }`, and a plain
  // spread of those would overwrite the profile defaults with undefined —
  // silently dropping remote-only and halving the limit.
  const defined = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as SearchParams;

  return searchJobs({
    queries: TARGET_QUERIES,
    location: SEARCH_DEFAULTS.location,
    remoteOnly: SEARCH_DEFAULTS.remoteOnly,
    hoursOld: SEARCH_DEFAULTS.hoursOld,
    sources: [...SEARCH_DEFAULTS.sources],
    maxFitTier: SEARCH_DEFAULTS.maxFitTier,
    limit: SEARCH_DEFAULTS.limit,
    excludeUrls: dismissed,
    ...defined,
  });
}

/** The wire/tool view of a ranked job: flat, no internal fields. */
export function presentJob(job: RankedJob) {
  const fit = stackFit(job);
  const level = matchLevel(job);
  return {
    title: job.title,
    company: job.company,
    source: job.source,
    applyUrl: job.url,
    location: job.location,
    salary: job.salary,
    postedAt: job.postedAt,
    tags: job.tags.slice(0, 8),
    // Exposed so a surprising order can be explained without reading the code.
    fit,
    match: {
      level,
      reason:
        level === "high"
          ? `Strong profile match (fit ${fit >= 0 ? "+" : ""}${fit})`
          : level === "medium"
            ? `Partial profile match (fit ${fit >= 0 ? "+" : ""}${fit})`
            : `Weak profile match (fit ${fit})`,
    },
    eligibility: {
      level: job.eligibility.level,
      reason: job.eligibility.reason,
    },
    // What the Polish boards publish beyond the shared fields.
    workMode: job.workMode ?? null,
    seniorityLevel: job.seniorityLevel ?? null,
    belowSalaryFloor: belowSalaryFloor(job),
    // From the posting text (src/workmode.ts); empty without a description.
    signals: workSignals(job),
  };
}
