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

import { scoreEligibility, levelRank, type Eligibility } from "./eligibility.ts";
import {
  DEFAULT_SOURCES,
  dedupeJobs,
  fetchAllSources,
  relevanceBoost,
  seniorityBucket,
  type Job,
  type SourceName,
  type SourceReport,
} from "./sources.ts";

export type RankedJob = Job & { eligibility: Eligibility };

export type SearchParams = {
  query?: string;
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
  afterSalary: number;
  returned: number;
  /** Excluded because minSalary was set and the posting publishes no salary. */
  hiddenForUnknownSalary: number;
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

  const outcome = await fetchAllSources({
    query: params.query,
    seniority: params.seniority,
    worldwideOnly: params.worldwideOnly,
    sources,
    limit: oversample(limit),
    location: params.location,
    remoteOnly: params.remoteOnly,
    hoursOld: params.hoursOld,
    linkedinDescriptions: params.linkedinDescriptions,
  });

  const deduped = dedupeJobs(outcome.jobs);

  const scored: RankedJob[] = deduped.map((job) => ({
    ...job,
    eligibility: scoreEligibility(job),
  }));

  const afterEligibility = dropLow
    ? scored.filter((job) => job.eligibility.level !== "low")
    : scored;

  // Strict on purpose: a posting with no published salary cannot be shown to
  // meet the floor, so it is excluded — but we count how many that hid.
  let hiddenForUnknownSalary = 0;
  const minSalary = params.minSalary;
  const afterSalary =
    minSalary === undefined
      ? afterEligibility
      : afterEligibility.filter((job) => {
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
    // 2. seniority bucket: senior first, internships last. Ahead of recency on
    //    purpose — a fresh internship is still the wrong job.
    const bySeniority = seniorityBucket(a) - seniorityBucket(b);
    if (bySeniority !== 0) return bySeniority;
    // 3. most recently posted first (unknown dates last)
    const aTime = a.postedAt ? Date.parse(a.postedAt) : 0;
    const bTime = b.postedAt ? Date.parse(b.postedAt) : 0;
    if (bTime !== aTime) return bTime - aTime;
    // 4. nudge for my stack
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
      afterSalary: afterSalary.length,
      returned: jobs.length,
      hiddenForUnknownSalary,
    },
  };
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
    eligibility: {
      level: job.eligibility.level,
      reason: job.eligibility.reason,
    },
  };
}
