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

import { listDismissedUrls } from "./db.ts";
import { scoreEligibility, levelRank, type Eligibility } from "./eligibility.ts";
import {
  SEARCH_DEFAULTS,
  TARGET_QUERIES,
  fitTier,
  relevanceBoost,
  seniorityBucket,
  stackFit,
} from "./profile.ts";
import {
  DEFAULT_SOURCES,
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
  /** Drop jobs above this fit tier (3 = wrong stack / junior / non-engineering). */
  maxFitTier?: number;
  /**
   * Exact URLs to drop — the "not interested" list. searchForProfile fills this
   * from the database, so a job dismissed in the dashboard also disappears from
   * `find_jobs` and from `harvest`. Pass [] to include dismissed jobs again.
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
  /** After the stack-fit filter (wrong stack / junior / non-engineering). */
  afterFit: number;
  afterSalary: number;
  returned: number;
  /** Excluded because minSalary was set and the posting publishes no salary. */
  hiddenForUnknownSalary: number;
  /** Excluded as a poor stack fit. */
  hiddenForFit: number;
  /** Excluded because they were dismissed ("not interested"). */
  hiddenForDismissed: number;
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

/**
 * Oversample hard. Measured against the live feeds, the eligibility filter
 * alone removes ~90% of a text search's Himalayas results, so fetching just
 * `limit` rows returns almost nothing. Three pages costs two extra requests
 * and roughly triples the usable hits.
 */
function oversample(limit: number): number {
  return Math.max(limit * 4, 60);
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

  const outcomes = await Promise.all(
    queries.map((query) => fetchAllSources({ ...common, query: query || undefined })),
  );

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
  const excluded = new Set(params.excludeUrls ?? []);
  const kept = excluded.size === 0 ? deduped : deduped.filter((job) => !excluded.has(job.url));
  const hiddenForDismissed = deduped.length - kept.length;

  const scored: RankedJob[] = kept.map((job) => ({
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

  const ranked = afterSalary.slice().sort((a, b) => {
    // 1. eligibility level, high before medium before low
    const byLevel = levelRank(a.eligibility.level) - levelRank(b.eligibility.level);
    if (byLevel !== 0) return byLevel;
    // 2. stack fit tier, ahead of recency. Recency used to win here, which put
    //    a fresh "Senior .NET Engineer" above every React role — it matched on
    //    "Full-Stack" and mentioned React in the body. Wrong stack now sinks.
    const byFit = fitTier(a) - fitTier(b);
    if (byFit !== 0) return byFit;
    // 2b. within a tier, compare fit in coarse bands so a much stronger match
    //     beats a marginally fresher one, while recency still decides between
    //     comparable jobs. Tier 0 spans 6..30+, which is too wide to ignore.
    const band = (job: RankedJob) => Math.floor(stackFit(job) / 8);
    const byBand = band(b) - band(a);
    if (byBand !== 0) return byBand;
    // 3. seniority bucket: senior first, internships last. Also ahead of
    //    recency — a fresh internship is still the wrong job.
    const bySeniority = seniorityBucket(a) - seniorityBucket(b);
    if (bySeniority !== 0) return bySeniority;
    // 4. most recently posted first (unknown dates last)
    const aTime = a.postedAt ? Date.parse(a.postedAt) : 0;
    const bTime = b.postedAt ? Date.parse(b.postedAt) : 0;
    if (bTime !== aTime) return bTime - aTime;
    // 5. fine-grained fit score inside the tier
    return relevanceBoost(b) - relevanceBoost(a);
  });

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
  // — dashboard, find_jobs, harvest — honours it without having to remember.
  const dismissed = listDismissedUrls();

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
    fit: stackFit(job),
    eligibility: {
      level: job.eligibility.level,
      reason: job.eligibility.reason,
    },
  };
}
