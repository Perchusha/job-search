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

import { belowSalaryFloor, payB2bPlnMonth, payVsFloor } from "./boards-pl.ts";
import { lastFetch, listDismissedKeys, loadPostings } from "./db.ts";
import { workSignals } from "./workmode.ts";
import { jobKey } from "./jobkey.ts";
import { scoreEligibility, levelRank, type Eligibility } from "./eligibility.ts";
import {
  SEARCH_DEFAULTS,
  TARGET_QUERIES,
  fitTier,
  matchLevel,
  officeAcceptable,
  relevanceBoost,
  seniorityBucket,
  stackFit,
} from "./profile.ts";
import {
  ALL_SOURCES,
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
  /**
   * Minimum pay, PLN per month, B2B-equivalent — the unit the profile's floor
   * is in (profile.ts SALARY: hourly ×168, UoP gross by my equivalence,
   * static FX). It used to compare raw numbers: Himalayas monthly and
   * foreign-currency figures against an annual floor, so "PLN 23k–30k /
   * monthly" failed an 80k floor and "INR 1200k / annual" passed it.
   */
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
  /** Himalayas: a second pass per query for roles open worldwide (sources.ts). */
  himalayasWorldwide?: boolean;
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
  /** What the fit gate left out (maxFitTier), for Настройки → Правила; empty without the gate. */
  fitDropped: RankedJob[];
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
    // and after the roles that do not. Office days at a giant in Warsaw
    // (profile.ts OFFICE_OK) are not friction.
    const friction = (job: RankedJob) =>
      Number((workSignals(job).mode !== null && !officeAcceptable(job)) || workSignals(job).polishRequired);
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

/** What the boards returned for one search, before dedupe and scoring. */
export type Fetched = { jobs: Job[]; reports: SourceReport[]; queries: string[] };

/**
 * Queries asked of a board at once. Ten at once was fine; fourteen (2026-10-30)
 * drew HTTP 429 from Himalayas on pages 2–3, and in a burst on page 1 too,
 * which failed the whole board.
 */
const QUERY_CONCURRENCY = 5;

/** `run` over `items`, at most `size` at a time; one promise per item, in order. */
function inBatches<T, R>(items: readonly T[], size: number, run: (item: T) => Promise<R>): Array<Promise<R>> {
  let running = 0;
  const waiting: Array<() => void> = [];
  const slot = () => (running < size ? (running++, Promise.resolve()) : new Promise<void>((resolve) => waiting.push(resolve)));
  const done = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
  return items.map(async (item) => {
    await slot();
    try {
      return await run(item);
    } finally {
      done();
    }
  });
}

/** Asks the boards. Everything after this is local: see rankFetched. */
export async function fetchJobs(params: SearchParams = {}): Promise<Fetched> {
  const limit = params.limit ?? DEFAULT_SEARCH_LIMIT;
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
    himalayasWorldwide: params.himalayasWorldwide,
  };

  // Boards that take no search term are fetched once, not once per query.
  // Their outcome goes first so their copy of a role (with pay) wins dedupe.
  const perPass = sources.filter((source) => PER_PASS_SOURCES.includes(source));
  const perQuery = sources.filter((source) => !PER_PASS_SOURCES.includes(source));
  const byQuery = async (query: string) => {
    const outcome = await fetchAllSources({ ...common, sources: perQuery, query: query || undefined });
    // Which query found what: Настройки → Поиск counts each query's yield from this.
    return query ? { ...outcome, jobs: outcome.jobs.map((job) => ({ ...job, foundBy: query })) } : outcome;
  };
  const outcomes = await Promise.all([
    ...(perPass.length > 0 ? [fetchAllSources({ ...common, sources: perPass })] : []),
    ...(perQuery.length > 0 ? inBatches(queries, QUERY_CONCURRENCY, byQuery) : []),
  ]);

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
  return {
    jobs: outcomes.flatMap((outcome) => outcome.jobs),
    reports: [...reportBySource.values()],
    queries: queries.filter((query) => query.length > 0),
  };
}

export async function searchJobs(params: SearchParams = {}): Promise<SearchResult> {
  return rankFetched(await fetchJobs(params), params);
}

/**
 * dedupe -> hidden -> date window -> eligibility -> fit -> salary -> rank.
 * The one implementation of everything after the fetch: a live search and the
 * stored postings (searchStored) both go through it.
 */
export function rankFetched(fetched: Fetched, params: SearchParams = {}): SearchResult {
  const limit = params.limit ?? DEFAULT_SEARCH_LIMIT;
  const dropLow = params.onlyEligible ?? true;
  const outcome = fetched;

  const deduped = dedupeJobs(outcome.jobs);

  // Dismissed jobs go first: no point scoring what will never be shown.
  const excluded = new Set((params.excludeUrls ?? []).map(jobKey));
  const kept =
    excluded.size === 0
      ? deduped
      : deduped.filter((job) => ![jobKey(job.url), ...(job.aliasKeys ?? [])].some((key) => excluded.has(key)));
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
          if (inDateWindow(job, hoursOld)) return true;
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
  const fitDropped: RankedJob[] = [];
  const maxTier = params.maxFitTier;
  const afterFit =
    maxTier === undefined
      ? afterEligibility
      : afterEligibility.filter((job) => {
          if (fitTier(job) <= maxTier) return true;
          hiddenForFit++;
          fitDropped.push(job);
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
          const monthly = job.pay?.length ? payB2bPlnMonth(job.pay) : null;
          const best = monthly ? (monthly.max ?? monthly.min) : null;
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
    fitDropped,
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
      queries: fetched.queries,
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
  return searchJobs(profileParams(overrides));
}

/**
 * The profile search's parameters with overrides on top. Reads the "not
 * interested" list here, so every caller of the profile search — dashboard and
 * find_jobs — honours it without having to remember.
 */
export function profileParams(overrides: SearchParams = {}): SearchParams {
  // Strip undefined before spreading. A caller forwarding optional arguments
  // passes `{ limit: undefined, remoteOnly: undefined, ... }`, and a plain
  // spread of those would overwrite the profile defaults with undefined —
  // silently dropping remote-only and halving the limit.
  const defined = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as SearchParams;

  return {
    queries: TARGET_QUERIES,
    location: SEARCH_DEFAULTS.location,
    remoteOnly: SEARCH_DEFAULTS.remoteOnly,
    hoursOld: SEARCH_DEFAULTS.hoursOld,
    sources: [...SEARCH_DEFAULTS.sources],
    maxFitTier: SEARCH_DEFAULTS.maxFitTier,
    limit: SEARCH_DEFAULTS.limit,
    excludeUrls: listDismissedKeys(),
    ...defined,
  };
}

/**
 * Stored postings as jobs, with an honest age. A board's postedAt is reset on
 * every renewal; first_seen is not. The earlier of the two is the posting's
 * age, and a postedAt more than a week after first_seen marks a repost.
 */
function storedAsJobs(sources: readonly SourceName[]): Job[] {
  const order = (source: string) => ALL_SOURCES.indexOf(source as SourceName);
  // Boards read whole each pass: what their last good pass listed is open.
  const passStart = new Map(
    sources.filter((source) => PER_PASS_SOURCES.includes(source)).map((source) => [source, lastFetch(source).lastSuccessStartedAt]),
  );
  return loadPostings(sources)
    .sort((a, b) => order(a.source) - order(b.source))
    .map(({ lastSeenAt, ...job }) => {
      const posted = job.postedAt ? Date.parse(job.postedAt) : NaN;
      const first = Date.parse(job.firstSeenAt);
      const reposted = Number.isFinite(posted) && posted - first > 7 * 86_400_000;
      const started = passStart.get(job.source);
      return {
        ...job,
        postedAt: Number.isFinite(posted) && posted < first ? job.postedAt : job.firstSeenAt,
        repostedAt: reposted ? job.postedAt : null,
        listed: Boolean(started && lastSeenAt >= started),
      };
    });
}

/**
 * Inside the date window: posted within `hoursOld`, undated, or — when the
 * window is the full one — still listed by a board read whole each pass. A
 * justjoin.it offer the employer keeps renewing is open at 50 days; counted
 * from its first publication, 27 such offers, 17 of them remote React roles,
 * were cut on 2026-10-24, and every watchlist role went 30 days after it was
 * first seen (company boards publish no dates). A narrower window still means
 * "posted recently".
 */
export function inDateWindow(job: Job, hoursOld: number, now = Date.now()): boolean {
  if (!job.postedAt || Date.parse(job.postedAt) >= now - hoursOld * 3_600_000) return true;
  return Boolean(job.listed) && hoursOld >= SEARCH_DEFAULTS.hoursOld;
}

/**
 * The profile search over what src/refresh.ts stored, instead of the boards:
 * milliseconds instead of seconds (or ~80 s with LinkedIn), and LinkedIn
 * included, since it was fetched in the background. Same ranking as a live
 * search. `reports` says which boards have never been fetched or last failed.
 */
export function searchStored(overrides: SearchParams = {}): SearchResult {
  const params = profileParams(overrides);
  const sources = params.sources?.length ? params.sources : DEFAULT_SOURCES;
  const jobs = storedAsJobs(sources);
  const reports: SourceReport[] = sources.map((source) => {
    const state = lastFetch(source);
    return {
      source,
      count: jobs.filter((job) => job.source === source).length,
      skipped: state.lastSuccessAt ? null : (state.lastError ?? "not fetched yet"),
    };
  });
  return rankFetched({ jobs, reports, queries: params.queries ?? [] }, params);
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
    // The published ranges: what «Подать» and apply-batch pass as --pay / --contract.
    pay: job.pay ?? null,
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
    // below / midlow / ok, as the criteria read a range; null without published pay.
    payState: payVsFloor(job),
    // The range in one unit, PLN a month B2B-equivalent, for the card beside the original.
    payMonthly: job.pay?.length ? payB2bPlnMonth(job.pay) : null,
    // Stored postings: when this tool first saw it, and a later re-post date.
    firstSeenAt: job.firstSeenAt ?? null,
    repostedAt: job.repostedAt ?? null,
    // Still listed by a board read whole: the page keeps it past the month window too.
    listed: job.listed ?? false,
    // From the posting text (src/workmode.ts); empty without a description.
    signals: workSignals(job),
  };
}
