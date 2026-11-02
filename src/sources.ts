/**
 * sources.ts — fetch + normalize jobs from three free, no-auth job feeds.
 *
 * Every source is wrapped so a single failing/rate-limited feed never breaks
 * find_jobs: fetchAllSources returns whatever succeeded plus human-readable
 * notes about what didn't.
 *
 * Field shapes below were verified against the live endpoints, not docs.
 */

import { fetchHackerNews, fetchJobicy, fetchWorkable } from "./boards-intl.ts";
import { fetchJustJoin, fetchNoFluffJobs } from "./boards-pl.ts";
import { fetchDou } from "./boards-ua.ts";
import { jobKey } from "./jobkey.ts";
import { companyKey, roleKey } from "./screening.ts";
import { fetchWatchlist, htmlToText } from "./watchlist.ts";
import {
  JobSpyUnavailable,
  PartialFetch,
  fetchJobSpy,
  isJobSpyAvailable,
  type JobSpySite,
} from "./jobspy.ts";

/**
 * Sources split in two families:
 *   - scraped via JobSpy (Python, optional): indeed, linkedin, glassdoor, ...
 *     Far more volume and real local-market coverage, but no salary data and no
 *     per-country eligibility metadata.
 *   - free public feeds (always available): himalayas, remoteok, arbeitnow.
 *     Thinner, but Himalayas carries the only real `locationRestrictions` and
 *     the only published salaries we get.
 *
 * Order matters: it decides who wins dedupe ties, so the richest record first.
 * Indeed leads on volume + descriptions; Himalayas is kept high because its
 * eligibility and salary metadata is worth more than a duplicate scrape.
 */
export type SourceName =
  | "watchlist"
  | "workable"
  | "jobicy"
  | "dou"
  | "hackernews"
  | "nofluffjobs"
  | "justjoin"
  | "indeed"
  | "linkedin"
  | "glassdoor"
  | "google"
  | "zip_recruiter"
  | "himalayas"
  | "remoteok"
  | "arbeitnow";

/** Sources fetched through the JobSpy bridge. */
export const JOBSPY_SOURCES: SourceName[] = [
  "indeed",
  "linkedin",
  "glassdoor",
  "google",
  "zip_recruiter",
];

/** Free public feeds, no scraping, no extra runtime. */
export const FEED_SOURCES: SourceName[] = ["himalayas", "remoteok", "arbeitnow"];

/** Polish IT boards read from their listing pages (src/boards-pl.ts). */
export const POLISH_SOURCES: SourceName[] = ["nofluffjobs", "justjoin"];

/**
 * Sources whose listing does not take a search term: one fetch per pass, not
 * one per TARGET_QUERY (searchJobs splits them out). Their URLs already encode
 * remote + senior + stack, and repeating them per query would download the
 * same page ten times. Workable asks its own few terms in one pass
 * (profile.ts WORKABLE_QUERIES), DOU its feeds; Hacker News is one thread a
 * month.
 */
export const PER_PASS_SOURCES: SourceName[] = [...POLISH_SOURCES, "watchlist", "workable", "jobicy", "dou", "hackernews"];

/**
 * Order decides which copy survives dedupe. The Polish boards go first: their
 * copy of a role carries pay per contract type, the Indeed copy carries none.
 * Workable's copy carries the whole text; a Hacker News post loses to any board.
 */
export const ALL_SOURCES: SourceName[] = [...POLISH_SOURCES, "watchlist", "workable", "jobicy", "dou", ...JOBSPY_SOURCES, ...FEED_SOURCES, "hackernews"];

/**
 * Default search set — Indeed for volume, Himalayas for salary + worldwide.
 *
 * LinkedIn is deliberately NOT here — it is the cost, not the coverage. Timed
 * on a full profile pass (5 queries, 160 requested per query):
 *   indeed 227 jobs + himalayas 291 ......... ~4s
 *   the same plus linkedin's 533 ............ 86s
 * So LinkedIn is roughly 95% of the wall clock, for coverage that is real —
 * ~900 postings Indeed does not have. The dashboard therefore ships it on but
 * gives it its own pill in the toolbar, so one click buys the fast search back.
 * This constant is only the fallback for callers that name no sources at all.
 *
 * glassdoor/zip_recruiter cannot serve Poland at all — measured: Glassdoor
 * throws "Glassdoor is not available for POLAND", and ZipRecruiter returns zero
 * rows even for a US location. google needs its own query syntax.
 */
export const DEFAULT_SOURCES: SourceName[] = ["indeed", "himalayas"];

/** One published pay range. Polish boards list one per contract type. */
export type PayRange = {
  contract: "b2b" | "uop" | "mandate" | "other";
  min: number | null;
  max: number | null;
  currency: string;
  unit: "hour" | "day" | "month" | "year";
  /** UoP figures are quoted gross; B2B net of VAT. */
  gross: boolean;
};

export type Job = {
  source: SourceName;
  externalId: string; // guid / slug / url
  title: string;
  company: string;
  url: string; // applicationLink or url
  location: string | null;
  remote: boolean;
  salary: string | null; // e.g. "USD 120k–160k / annual" if available
  /**
   * Raw numbers behind `salary`, kept so find_jobs can filter by minSalary
   * without re-parsing the display string. null when the feed omits salary.
   */
  salaryMin: number | null;
  salaryMax: number | null;
  tags: string[];
  postedAt: string | null; // ISO
  locationRestrictions: string[]; // Himalayas only; [] otherwise
  /**
   * Posting body, when the source provides one (JobSpy/Indeed does, LinkedIn
   * only on request). Truncated at fetch time. Kept off tool responses on
   * purpose — it is for drafting cover letters, not for filling context.
   */
  description?: string | null;
  /** Pay per contract type, when the board publishes it (Polish boards). */
  pay?: PayRange[];
  /** The board's own work-mode field, when it has one. */
  workMode?: "remote" | "hybrid" | "office" | null;
  /** The board's own seniority level ("senior", "Mid-level"…), when it has one. */
  seniorityLevel?: string | null;
  /** Stored postings only: when this tool first saw it (src/db.ts postings). */
  firstSeenAt?: string;
  /** Stored postings only: the board's later postedAt, when it was re-posted. */
  repostedAt?: string | null;
  /**
   * Keys of the copies dedupeJobs folded into this one (other boards, other
   * links). An application or a hide on any of them counts for this one.
   */
  aliasKeys?: string[];
  /**
   * Stored postings of a board read whole each pass (PER_PASS_SOURCES): the
   * last good pass still listed it, so it is open, however old its date.
   */
  listed?: boolean;
  /**
   * The search query that returned it, on the boards asked per query
   * (pipeline.ts fetchJobs). Stored in posting_queries, not with the posting:
   * one posting is often found by several.
   */
  foundBy?: string;
};

export type FetchOptions = {
  query?: string;
  seniority?: string;
  employmentType?: string;
  worldwideOnly?: boolean;
  sources?: SourceName[];
  /** How many results the caller ultimately wants; drives Himalayas paging. */
  limit?: number;
  /**
   * Himalayas: also ask each query for roles open worldwide (a second pass).
   * The background refresh sets it; live searches leave it off, since the
   * doubled requests drew HTTP 429 when searches came in a burst.
   */
  himalayasWorldwide?: boolean;
  /** JobSpy only: free-text location for the scrape, e.g. "Poland". */
  location?: string;
  /** JobSpy only: restrict the scrape to remote postings. */
  remoteOnly?: boolean;
  /** JobSpy only: ignore postings older than this many hours (default 14 days). */
  hoursOld?: number;
  /** JobSpy/LinkedIn only: also fetch descriptions (one extra request per job). */
  linkedinDescriptions?: boolean;
};

/**
 * What one source did on this run. Structured rather than a printable string so
 * both consumers (MCP text summary, dashboard UI) can render it their own way,
 * and so "skipped" is distinguishable from "returned 0 jobs".
 */
export type SourceReport = {
  source: SourceName;
  count: number;
  /** Non-null when the source was skipped: rate limit, outage, bad payload. */
  skipped: string | null;
};

export type FetchOutcome = {
  jobs: Job[];
  reports: SourceReport[];
};

/** "himalayas: 60 jobs | remoteok: SKIPPED — rate limited (HTTP 429)" */
export function formatSourceReports(reports: SourceReport[]): string {
  return reports
    .map((report) =>
      report.skipped === null
        ? `${report.source}: ${report.count} jobs`
        : `${report.source}: SKIPPED — ${report.skipped}`,
    )
    .join(" | ");
}

const USER_AGENT = "job-hunt-mcp";
const REQUEST_TIMEOUT_MS = 20_000;
const HIMALAYAS_PAGE_SIZE = 20; // hard server-side cap
const HIMALAYAS_MAX_PAGES = 3;

/** Thrown when a source should be skipped rather than treated as a hard error. */
class SourceSkipped extends Error {}

async function fetchJson(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        // RemoteOK 403s some default agents; harmless elsewhere.
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SourceSkipped(`network error (${reason})`);
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    throw new SourceSkipped(
      `rate limited (HTTP 429)${retryAfter ? `, retry after ${retryAfter}s` : ""}`,
    );
  }
  if (!response.ok) {
    throw new SourceSkipped(`HTTP ${response.status} ${response.statusText}`);
  }

  try {
    return (await response.json()) as unknown;
  } catch {
    throw new SourceSkipped("response was not valid JSON");
  }
}

/* ------------------------------------------------------------------ */
/* Small parsing helpers — every feed is treated as untrusted input.    */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => asString(entry)).filter((entry): entry is string => entry !== null);
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Feeds are inconsistent: Himalayas `pubDate` and Arbeitnow `created_at` are
 * UNIX **seconds**, RemoteOK `date` is an ISO string. Accept all three, plus
 * millisecond epochs, and return ISO or null.
 */
function toIsoDate(value: unknown): string | null {
  const numeric = asNumber(value);
  if (numeric !== null && numeric > 0) {
    // 10-digit values are seconds, 13-digit are milliseconds.
    const ms = numeric < 100_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const text = asString(value);
  if (text === null) return null;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** 130000 -> "130k"; 950 -> "950". */
function compactAmount(amount: number): string {
  if (Math.abs(amount) >= 1000) {
    const thousands = amount / 1000;
    const rounded = Number.isInteger(thousands) ? String(thousands) : thousands.toFixed(1);
    return `${rounded}k`;
  }
  return String(Math.round(amount));
}

type SalaryFields = Pick<Job, "salary" | "salaryMin" | "salaryMax">;

function salaryFields(
  min: number | null,
  max: number | null,
  currency: string | null,
  period: string | null,
): SalaryFields {
  // Feeds use 0 (RemoteOK) and null (Himalayas) interchangeably for "unknown".
  const low = min !== null && min > 0 ? min : null;
  const high = max !== null && max > 0 ? max : null;
  if (low === null && high === null) return { salary: null, salaryMin: null, salaryMax: null };

  const range =
    low !== null && high !== null && low !== high
      ? `${compactAmount(low)}–${compactAmount(high)}`
      : compactAmount((low ?? high) as number);

  const salary = [currency, range, period ? `/ ${period}` : null]
    .filter((part): part is string => Boolean(part))
    .join(" ");

  return { salary, salaryMin: low, salaryMax: high };
}

/* ------------------------------------------------------------------ */
/* 1. Himalayas — primary source, richest eligibility metadata         */
/* ------------------------------------------------------------------ */

/**
 * The payload is normally `{ jobs: [...] }`, but the endpoint has changed
 * shape before (its own `comments` field documents a pagination migration),
 * so accept a bare array or any of the common wrapper keys.
 */
function unwrapJobArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = asRecord(payload);
  if (!record) return [];
  for (const key of ["jobs", "results", "data"]) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

function normalizeHimalayas(raw: unknown): Job | null {
  const job = asRecord(raw);
  if (!job) return null;

  const title = asString(job["title"]);
  const company = asString(job["companyName"]);
  // guid first: it is the posting's own page and carries no tracking. Since
  // October 2026 applicationLink always ends in ?utm_source=api, and every
  // job hidden or applied to before that was stored without it.
  const url = asString(job["guid"]) ?? asString(job["applicationLink"]);
  if (!title || !company || !url) return null;

  // Verified live field names: `timezoneRestrictions` and `categories` are
  // plural, and seniority is an array.
  const tags = [
    ...asStringArray(job["categories"]),
    ...asStringArray(job["parentCategories"]),
    ...asStringArray(job["seniority"]),
    ...asStringArray(job["timezoneRestrictions"]),
  ];
  const employmentType = asString(job["employmentType"]);
  if (employmentType) tags.push(employmentType);

  return {
    source: "himalayas",
    externalId: asString(job["guid"]) ?? url,
    title,
    company,
    url,
    // Himalayas lists countries the candidate must be in, not an office city.
    location: asStringArray(job["locationRestrictions"]).join(", ") || null,
    remote: true, // Himalayas is a remote-only board.
    ...salaryFields(
      asNumber(job["minSalary"]),
      asNumber(job["maxSalary"]),
      asString(job["currency"]),
      asString(job["salaryPeriod"]),
    ),
    // The same figures as a pay range, so the salary floor and the B2B-
    // equivalent comparison apply to Himalayas too — "INR 1200k / annual"
    // (≈4k PLN a month) used to rank like any other salaried role.
    pay: himalayasPay(job),
    tags: [...new Set(tags)],
    postedAt: toIsoDate(job["pubDate"]),
    locationRestrictions: asStringArray(job["locationRestrictions"]),
    // The search API sends the whole body; the posting's page sits behind
    // Cloudflare, so this is the only copy of the text there is (Claude's
    // verdict reads it, src/verdict.ts). Cut like every other board's.
    description: htmlToText(asString(job["description"]) ?? "").slice(0, 8000) || null,
  };
}

function himalayasPay(job: Record<string, unknown>): PayRange[] {
  const min = asNumber(job["minSalary"]);
  const max = asNumber(job["maxSalary"]);
  const currency = asString(job["currency"]);
  if (!currency || ((min ?? 0) <= 0 && (max ?? 0) <= 0)) return [];
  const period = (asString(job["salaryPeriod"]) ?? "").toLowerCase();
  const unit: PayRange["unit"] = period.startsWith("hour")
    ? "hour"
    : period.startsWith("day")
      ? "day"
      : period.startsWith("month")
        ? "month"
        : "year";
  // Contract unknown: compared as if B2B, with no UoP scaling.
  return [{ contract: "other", min: min && min > 0 ? min : null, max: max && max > 0 ? max : null, currency, unit, gross: false }];
}

async function fetchHimalayas(options: FetchOptions): Promise<Job[]> {
  const wanted = options.limit ?? 20;
  const pages = Math.min(HIMALAYAS_MAX_PAGES, Math.max(1, Math.ceil(wanted / HIMALAYAS_PAGE_SIZE)));
  const collected: Job[] = [];

  for (let page = 1; page <= pages; page++) {
    const params = new URLSearchParams();
    if (options.query) params.set("q", options.query);
    if (options.seniority) params.set("seniority", options.seniority);
    if (options.employmentType) params.set("employment_type", options.employmentType);
    if (options.worldwideOnly) params.set("worldwide", "true");
    params.set("sort", options.query ? "relevant" : "recent");
    // Upstream quirk (verified, reproducible): `q` + `sort=relevant` + `page=1`
    // returns HTTP 503, while the identical request without `page` returns 200.
    // page=1 is the server default, so omitting it costs nothing and avoids the
    // 503 on the most common path — a text search's first page.
    if (page > 1) params.set("page", String(page));

    // A failed later page keeps what the earlier ones returned. It used to
    // throw, discarding the whole query's rows for one 503 on page 2.
    let payload: unknown;
    try {
      payload = await fetchJson(`https://himalayas.app/jobs/api/search?${params.toString()}`);
    } catch (error) {
      if (page === 1) throw error;
      console.error(`himalayas: page ${page} of "${options.query ?? ""}" failed, keeping pages 1-${page - 1}`);
      break;
    }
    const rows = unwrapJobArray(payload);

    // Only an empty page means "no more results". A short page does not: the
    // endpoint routinely returns 19 of a 20-row page (expired posts are
    // dropped after paging), and treating that as the end under-fetches.
    if (rows.length === 0) break;

    for (const row of rows) {
      const job = normalizeHimalayas(row);
      if (job) collected.push(job);
    }
  }

  return collected;
}

/**
 * The profile search asks Himalayas twice: as before, and for roles open
 * worldwide. Its 60 rows a query (3 pages, always full) were 90% roles
 * restricted to one country that is not Poland — 426 of 474 stored rows, 48
 * open to Poland. The worldwide pass is open by definition. A failed second
 * pass keeps the first.
 */
async function fetchHimalayasBoth(options: FetchOptions): Promise<Job[]> {
  if (options.worldwideOnly) return fetchHimalayas(options);
  // One after the other: the queries already run side by side, and the two
  // passes at once drew HTTP 429.
  const usual = await fetchHimalayas(options);
  // Spread out, and once more after a 429: the ten queries' second passes at
  // once drew "rate limited" from Himalayas.
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const worldwidePass = () => fetchHimalayas({ ...options, worldwideOnly: true });
  await pause(1000 + Math.random() * 4000);
  const worldwide = await worldwidePass()
    .catch(async (error: unknown) => {
      if (!/429|rate limit/i.test(String(error))) throw error;
      await pause(8000 + Math.random() * 8000);
      return worldwidePass();
    })
    .catch((error: unknown) => {
      console.error(`himalayas worldwide pass failed: ${error instanceof Error ? error.message : error}`);
      return [] as Job[];
    });
  return [...usual, ...worldwide];
}

/* ------------------------------------------------------------------ */
/* 2. RemoteOK — good volume, mostly worldwide-remote                  */
/* ------------------------------------------------------------------ */

function normalizeRemoteOk(raw: unknown): Job | null {
  const job = asRecord(raw);
  if (!job) return null;

  const title = asString(job["position"]) ?? asString(job["title"]);
  const company = asString(job["company"]);
  const url = asString(job["url"]) ?? asString(job["apply_url"]);
  if (!title || !company || !url) return null;

  return {
    source: "remoteok",
    externalId: asString(job["id"]) ?? asString(job["slug"]) ?? url,
    title,
    company,
    // Values look like "Newtownards, " — trim the dangling separator.
    location: asString(job["location"])?.replace(/[,\s]+$/, "") ?? null,
    url,
    remote: true, // RemoteOK is a remote-only board.
    ...salaryFields(asNumber(job["salary_min"]), asNumber(job["salary_max"]), "USD", "annual"),
    tags: asStringArray(job["tags"]),
    postedAt: toIsoDate(job["date"]) ?? toIsoDate(job["epoch"]),
    locationRestrictions: [],
  };
}

async function fetchRemoteOk(options: FetchOptions): Promise<Job[]> {
  const payload = await fetchJson("https://remoteok.com/api");
  if (!Array.isArray(payload)) throw new SourceSkipped("expected a JSON array");

  // Index 0 is a legal/metadata object, never a job.
  const jobs = payload
    .slice(1)
    .map((row) => normalizeRemoteOk(row))
    .filter((job): job is Job => job !== null);

  // No server-side search — filter locally.
  return filterByQuery(jobs, options.query);
}

/* ------------------------------------------------------------------ */
/* 3. Arbeitnow — EU focused                                           */
/* ------------------------------------------------------------------ */

function normalizeArbeitnow(raw: unknown): Job | null {
  const job = asRecord(raw);
  if (!job) return null;

  const title = asString(job["title"]);
  const company = asString(job["company_name"]);
  const url = asString(job["url"]);
  if (!title || !company || !url) return null;

  return {
    source: "arbeitnow",
    externalId: asString(job["slug"]) ?? url,
    title,
    company,
    url,
    location: asString(job["location"]),
    remote: job["remote"] === true,
    // Not exposed by this feed.
    salary: null,
    salaryMin: null,
    salaryMax: null,
    tags: [...new Set([...asStringArray(job["tags"]), ...asStringArray(job["job_types"])])],
    postedAt: toIsoDate(job["created_at"]),
    locationRestrictions: [],
  };
}

async function fetchArbeitnow(options: FetchOptions): Promise<Job[]> {
  const payload = await fetchJson("https://www.arbeitnow.com/api/job-board-api");
  const rows = unwrapJobArray(payload);
  const jobs = rows
    .map((row) => normalizeArbeitnow(row))
    .filter((job): job is Job => job !== null);

  return filterByQuery(jobs, options.query);
}

/* ------------------------------------------------------------------ */
/* Local filtering, dedupe, ranking                                    */
/* ------------------------------------------------------------------ */

/** Every whitespace-separated term must appear somewhere in the job text. */
function filterByQuery(jobs: Job[], query?: string): Job[] {
  const terms = (query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
  if (terms.length === 0) return jobs;

  return jobs.filter((job) => {
    const haystack = [job.title, job.company, job.location ?? "", ...job.tags]
      .join(" ")
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/**
 * Company and title as screening.ts compares them: "Xebia sp. z o.o." is
 * Xebia, "Front-end Engineer (m/f/d)" is "frontend engineer". Compared raw,
 * a role posted on two boards under two spellings stayed two cards, and the
 * copy of one already applied to came back in "Good fit".
 */
function companyTitleKey(job: Job): string {
  return `${companyKey(job.company)}|${roleKey(job.title)}`;
}

/** No restriction, or one that includes Poland. */
function opensToPoland(restrictions: string[]): boolean {
  return (
    restrictions.length === 0 ||
    /\b(?:poland|polska|europe|eu|european union|emea|worldwide|anywhere)\b/i.test(restrictions.join(" "))
  );
}

/**
 * Dedupe by jobKey first (tracking parameters ignored, job ids in the query
 * kept — see jobkey.ts), then by company+title. The first copy wins, with one
 * exception: Himalayas publishes one URL per country for the same role, and
 * when a variant for another country came first ("Frontend Engineer — UK",
 * then the same role for Poland), the role was scored as out of reach and
 * dropped. A later copy that is open to Poland replaces one that is not.
 */
export function dedupeJobs(jobs: Job[]): Job[] {
  const seenUrls = new Set<string>();
  const byCompanyTitle = new Map<string, number>();
  const unique: Job[] = [];

  for (const job of jobs) {
    const urlKey = jobKey(job.url);
    if (seenUrls.has(urlKey)) continue;
    const nameKey = companyTitleKey(job);
    const at = byCompanyTitle.get(nameKey);
    if (at !== undefined) {
      const kept = unique[at] as Job;
      const keptKey = jobKey(kept.url);
      if (
        kept.locationRestrictions.length > 0 &&
        !opensToPoland(kept.locationRestrictions) &&
        job.locationRestrictions.length > 0 &&
        opensToPoland(job.locationRestrictions)
      ) {
        unique[at] = { ...job, aliasKeys: [...(kept.aliasKeys ?? []), keptKey] };
        seenUrls.add(urlKey);
      } else {
        // The kept copy wins, but not by throwing away what only the other
        // copy publishes: CommIT's Indeed listing beat its Himalayas one, and
        // the PLN 23–30k range went with it.
        const pay =
          !kept.pay?.length && job.pay?.length
            ? { pay: job.pay, salary: job.salary, salaryMin: job.salaryMin, salaryMax: job.salaryMax }
            : {};
        unique[at] = { ...kept, ...pay, aliasKeys: [...(kept.aliasKeys ?? []), urlKey] };
        seenUrls.add(urlKey);
      }
      continue;
    }
    seenUrls.add(urlKey);
    byCompanyTitle.set(nameKey, unique.length);
    unique.push(job);
  }

  return unique;
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Fetch every requested source concurrently. A rejected source becomes a note,
 * not an exception — one dead feed must not break the tool.
 */
export async function fetchAllSources(options: FetchOptions = {}): Promise<FetchOutcome> {
  const requested = options.sources?.length ? options.sources : DEFAULT_SOURCES;
  // Keep ALL_SOURCES order so the richest record wins dedupe ties.
  const ordered = ALL_SOURCES.filter((source) => requested.includes(source));

  /** One JobSpy site, fetched through the Python bridge. */
  const scrape = (site: SourceName) => async (opts: FetchOptions): Promise<Job[]> => {
    if (!isJobSpyAvailable()) {
      throw new JobSpyUnavailable("JobSpy not installed — run `npm run setup:jobspy`");
    }
    return fetchJobSpy({
      sites: [site as JobSpySite],
      query: opts.query,
      location: opts.location ?? "Poland",
      isRemote: opts.remoteOnly ?? false,
      resultsWanted: Math.min(opts.limit ?? 50, 200),
      hoursOld: opts.hoursOld,
      linkedinFetchDescription: site === "linkedin" ? opts.linkedinDescriptions : false,
    });
  };

  const fetchers: Record<SourceName, (options: FetchOptions) => Promise<Job[]>> = {
    nofluffjobs: () => fetchNoFluffJobs(),
    watchlist: () => fetchWatchlist(),
    justjoin: () => fetchJustJoin(),
    workable: (opts) => fetchWorkable(opts),
    jobicy: () => fetchJobicy(),
    dou: () => fetchDou(),
    hackernews: () => fetchHackerNews(),
    indeed: scrape("indeed"),
    linkedin: scrape("linkedin"),
    glassdoor: scrape("glassdoor"),
    google: scrape("google"),
    zip_recruiter: scrape("zip_recruiter"),
    himalayas: (opts) => (opts.himalayasWorldwide ? fetchHimalayasBoth(opts) : fetchHimalayas(opts)),
    remoteok: fetchRemoteOk,
    arbeitnow: fetchArbeitnow,
  };

  const settled = await Promise.allSettled(
    ordered.map((source) => fetchers[source](options)),
  );

  const jobs: Job[] = [];
  const reports: SourceReport[] = [];

  settled.forEach((result, index) => {
    const source = ordered[index] as SourceName;
    if (result.status === "fulfilled") {
      jobs.push(...result.value);
      reports.push({ source, count: result.value.length, skipped: null });
    } else if (result.reason instanceof PartialFetch) {
      // Stopped part-way (LinkedIn's 429): keep what was read, and say so.
      jobs.push(...result.reason.jobs);
      reports.push({ source, count: result.reason.jobs.length, skipped: result.reason.message });
    } else {
      const reason =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      reports.push({ source, count: 0, skipped: reason });
    }
  });

  return { jobs, reports };
}
