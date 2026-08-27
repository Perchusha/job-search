/**
 * sources.ts — fetch + normalize jobs from three free, no-auth job feeds.
 *
 * Every source is wrapped so a single failing/rate-limited feed never breaks
 * find_jobs: fetchAllSources returns whatever succeeded plus human-readable
 * notes about what didn't.
 *
 * Field shapes below were verified against the live endpoints, not docs.
 */

import {
  JobSpyUnavailable,
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

export const ALL_SOURCES: SourceName[] = [...JOBSPY_SOURCES, ...FEED_SOURCES];

/**
 * Default search set — Indeed for volume, Himalayas for salary + worldwide.
 *
 * LinkedIn is deliberately NOT here. Measured on a real search: it took 25 of
 * 28 total seconds (~0.5s/job vs Indeed's ~0.013s), and contributed 0 of the
 * top 15 results, because it populates `is_remote` on roughly 1 job in 50 so
 * everything scores `medium` and gets outranked. Ask for it explicitly when
 * you want its coverage and can wait.
 *
 * glassdoor/zip_recruiter are US-centric; google needs its own query syntax.
 */
export const DEFAULT_SOURCES: SourceName[] = ["indeed", "himalayas"];

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
};

export type FetchOptions = {
  query?: string;
  seniority?: string;
  employmentType?: string;
  worldwideOnly?: boolean;
  sources?: SourceName[];
  /** How many results the caller ultimately wants; drives Himalayas paging. */
  limit?: number;
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
  const url = asString(job["applicationLink"]) ?? asString(job["guid"]);
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
    tags: [...new Set(tags)],
    postedAt: toIsoDate(job["pubDate"]),
    locationRestrictions: asStringArray(job["locationRestrictions"]),
  };
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

    const payload = await fetchJson(`https://himalayas.app/jobs/api/search?${params.toString()}`);
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

/** Strip protocol/www/query/hash/trailing slash so the same job matches. */
function normalizeUrl(url: string): string {
  return url
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

function companyTitleKey(job: Job): string {
  const squash = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
  return `${squash(job.company)}|${squash(job.title)}`;
}

/**
 * Dedupe by normalized URL first, then by company+title. Source order decides
 * the winner, so callers should pass Himalayas first — its records carry the
 * eligibility metadata the scorer depends on.
 */
export function dedupeJobs(jobs: Job[]): Job[] {
  const seenUrls = new Set<string>();
  const seenCompanyTitle = new Set<string>();
  const unique: Job[] = [];

  for (const job of jobs) {
    const urlKey = normalizeUrl(job.url);
    const nameKey = companyTitleKey(job);
    if (seenUrls.has(urlKey) || seenCompanyTitle.has(nameKey)) continue;
    seenUrls.add(urlKey);
    seenCompanyTitle.add(nameKey);
    unique.push(job);
  }

  return unique;
}

/**
 * Stack fit — the two lists that decide what ranks highly. Taken from the CV,
 * not guessed. This is the single place that encodes "what I actually do".
 *
 * Matching is whole-word (see `hasTerm`), which matters a lot here: a naive
 * includes("java") matches "JavaScript", and includes("go") matches
 * "Go-to-market".
 */
const STACK_WEIGHTS: Array<[term: string, weight: number]> = [
  // core day-to-day
  ["typescript", 3],
  ["javascript", 2],
  ["react", 3],
  ["next.js", 3],
  ["nextjs", 3],
  ["node", 2],
  ["node.js", 2],
  ["nestjs", 2],
  ["nest.js", 2],
  ["fullstack", 2],
  ["full-stack", 2],
  ["full stack", 2],
  ["frontend", 2],
  ["front-end", 2],
  ["front end", 2],
  // APIs / realtime
  ["graphql", 2],
  ["rest api", 1],
  ["websocket", 2],
  ["socket.io", 1],
  ["express", 1],
  // data
  ["postgres", 1],
  ["postgresql", 1],
  ["mongodb", 1],
  ["firestore", 1],
  ["supabase", 2],
  // AI / LLM — a real specialisation on the CV, not a buzzword
  ["llm", 2],
  ["openai", 2],
  ["anthropic", 2],
  ["claude", 2],
  ["prompt engineering", 2],
  ["ai engineer", 2],
  ["mcp", 1],
  // ui / state
  ["redux", 1],
  ["zustand", 1],
  ["tailwind", 1],
  ["mui", 1],
  ["storybook", 1],
  ["vite", 1],
  ["ssr", 1],
  ["accessibility", 1],
  // desktop
  ["electron", 2],
  // infra / practice
  ["docker", 1],
  ["ci/cd", 1],
  ["github actions", 1],
  ["vercel", 1],
  ["stripe", 1],
  ["microservices", 1],
  ["system design", 1],
  ["tech lead", 1],
  // current job's stack — real experience, but not a target role on its own
  ["symfony", 1],
  ["twig", 1],
  ["stimulus", 1],
];

/**
 * Stacks I do not work in. A negative weight, applied hardest to the TITLE,
 * because a title says what the role *is* while a description mentions
 * everything under the sun.
 *
 * This exists because of a real result: searching "React" on Indeed PL put
 * "Senior .NET Engineer (Full-Stack, Front-End, Cloud & AI)" at the very top —
 * it mentions React in the body and matched on "Full-Stack".
 *
 * `php` is deliberately mild: Symfony/Twig is my current day job, so PHP is not
 * foreign — but "Senior PHP Engineer" is still not the role I want. Raise or
 * drop it here if that changes.
 */
const FOREIGN_STACK: Array<[term: string, penalty: number]> = [
  [".net", 6],
  ["c#", 6],
  ["asp.net", 6],
  ["java", 6],
  ["spring boot", 5],
  ["kotlin", 4],
  ["scala", 4],
  ["python", 4],
  ["django", 5],
  ["ruby", 5],
  ["rails", 5],
  ["golang", 4],
  ["rust", 4],
  ["c++", 6],
  ["php", 2],
  ["laravel", 4],
  ["wordpress", 4],
  ["drupal", 4],
  ["magento", 4],
  ["salesforce", 6],
  ["sap", 6],
  ["abap", 6],
  ["sharepoint", 5],
  ["android", 4],
  ["ios", 4],
  ["swift", 4],
  // React Native is not on the CV: React knowledge transfers, but mobile is a
  // different job. Mild on purpose — enough to keep it out of the top, not
  // enough to hide it. "react" alone scores +6 in a title, so this lands it
  // near neutral rather than banned.
  ["react native", 2],
  ["flutter", 4],
  ["unity", 4],
  ["unreal", 4],
  ["embedded", 4],
  // adjacent engineering roles, not mine
  ["qa engineer", 5],
  ["tester", 5],
  ["devops engineer", 3],
  ["data engineer", 4],
  ["data scientist", 4],
  // not engineering at all — these really do come back from a "react" search
  ["recruiter", 6],
  ["talent acquisition", 6],
  ["accountant", 6],
  ["sales", 5],
  ["marketing", 5],
  ["user acquisition", 5],
  ["designer", 5],
  ["product manager", 5],
  ["project manager", 5],
  ["scrum master", 5],
  ["business analyst", 5],
  ["account manager", 5],
  ["customer success", 5],
  ["support specialist", 5],
];

/**
 * Whole-word term test. Terms ending in a symbol (".net", "c#", "c++") get no
 * trailing boundary, because a word boundary never fires after a symbol.
 */
function hasTerm(haystack: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const trailing = /[a-z0-9]$/.test(term) ? "(?![a-z0-9])" : "";
  return new RegExp(`(?<![a-z0-9])${escaped}${trailing}`, "i").test(haystack);
}

/**
 * Coarse seniority bucket from the title: 0 = senior, 1 = unstated, 2 = junior.
 * Lower sorts first.
 *
 * Scraped boards accept no seniority filter (only Himalayas does), so an
 * "Internship – Full-stack Engineer" would otherwise rank alongside a staff
 * role purely on recency. Includes Polish terms because Indeed PL is bilingual.
 */
const JUNIOR_MARKERS = [
  "intern",
  "internship",
  "junior",
  "jr.",
  "trainee",
  "graduate",
  "entry level",
  "entry-level",
  "apprentice",
  "praktyk", // praktykant / praktyki
  "staż", // staż / stażysta
  "młodszy", // "junior" in Polish
];

const SENIOR_MARKERS = [
  "senior",
  "sr.",
  "lead",
  "staff",
  "principal",
  "architect",
  "head of",
  "starszy", // "senior" in Polish
];

export function seniorityBucket(job: Job): number {
  const title = job.title.toLowerCase();
  // Junior wins ties: "Junior/Senior" listings are really junior openings.
  if (JUNIOR_MARKERS.some((marker) => title.includes(marker))) return 2;
  if (SENIOR_MARKERS.some((marker) => title.includes(marker))) return 0;
  return 1;
}

/**
 * How well a posting matches my stack. Positive = good fit, negative = wrong
 * stack. Title counts double for matches and triple for penalties.
 */
export function stackFit(job: Job): number {
  const title = job.title.toLowerCase();
  const rest = job.tags.join(" ").toLowerCase();

  let score = 0;
  for (const [term, weight] of STACK_WEIGHTS) {
    if (hasTerm(title, term)) score += weight * 2;
    else if (hasTerm(rest, term)) score += weight;
  }
  for (const [term, penalty] of FOREIGN_STACK) {
    // A foreign stack named in the title is close to disqualifying.
    if (hasTerm(title, term)) score -= penalty * 3;
    else if (hasTerm(rest, term)) score -= penalty;
  }

  // A junior/intern opening is as poor a fit for an 8-year senior as a foreign
  // stack, and folding it in here keeps ranking to one coherent score. Without
  // it, "Internship - Full-stack Engineer" outranked a senior role whose title
  // happened to name no technology.
  if (seniorityBucket(job) === 2) score -= 12;

  return score;
}

/**
 * Coarse fit tier, so recency still has room to work *within* a tier instead of
 * raw scores deciding everything. Lower sorts first.
 */
export function fitTier(job: Job): number {
  const score = stackFit(job);
  if (score < 0) return 3; // wrong stack — bottom of the list
  if (score >= 6) return 0; // clear match
  if (score > 0) return 1; // partial match
  return 2; // nothing recognised either way
}

/** Fine-grained tiebreak inside a tier. */
export function relevanceBoost(job: Job): number {
  return stackFit(job);
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
    indeed: scrape("indeed"),
    linkedin: scrape("linkedin"),
    glassdoor: scrape("glassdoor"),
    google: scrape("google"),
    zip_recruiter: scrape("zip_recruiter"),
    himalayas: fetchHimalayas,
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
    } else {
      const reason =
        result.reason instanceof Error ? result.reason.message : String(result.reason);
      reports.push({ source, count: 0, skipped: reason });
    }
  });

  return { jobs, reports };
}
