/**
 * boards-intl.ts — boards outside the scraped ones: Workable's public job
 * search, Hacker News' monthly "Who is hiring?" thread and, since the same
 * evening, jobicy.com's API (14 fresh frontend roles open to Poland that no
 * other board had, 10 of their companies new, among them Ashby's EU product
 * engineering).
 *
 * Added on 2026-10-30, when Claude kept ~1–5 cards a day and the boards above
 * were read through. Probed on 2026-10-26 and again that day:
 *   - jobs.workable.com/api/v1/jobs answers JSON with the whole posting
 *     (?query=react&location=Poland&workplace=remote: 25 rows), several
 *     companies the store had never seen (Soda Data, Netguru, Creditstar).
 *     robots.txt disallows only /search with a query, not /api.
 *   - hn.algolia.com: the October 2026 thread held 262 posts, 47 of them
 *     remote and open to Europe or worldwide, 16 of those with a JS stack.
 *     Few, but product companies that post nowhere else.
 *
 * Both are read once per pass (PER_PASS_SOURCES): Workable with its own short
 * list of terms (profile.ts WORKABLE_QUERIES), one after another; Hacker News
 * as one thread, the latest. A pass that finds nothing throws, so a changed
 * API shows up as a failed board rather than as silence.
 */

import { payFields } from "./boards-pl.ts";
import { REGION_AMERICAS, REGION_OPEN, scoreEligibility } from "./eligibility.ts";
import { WORKABLE_QUERIES, fitTier } from "./profile.ts";
import type { FetchOptions, Job, PayRange } from "./sources.ts";
import { htmlToText } from "./watchlist.ts";

const USER_AGENT = "job-hunt-mcp";
const REQUEST_TIMEOUT_MS = 20_000;
const TEXT_CAP = 8000;

type Raw = Record<string, unknown>;

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
const record = (value: unknown): Raw | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Raw) : null;

async function fetchJson(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`network error (${error instanceof Error ? error.message : String(error)})`);
  }
  if (response.status === 429) throw new Error("rate limited (HTTP 429)");
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.json() as Promise<unknown>;
}

/** Older than the profile window: a board that takes no date filter is cut here. */
function tooOld(postedAt: string | null, hoursOld: number | undefined): boolean {
  if (!postedAt || hoursOld === undefined) return false;
  return Date.parse(postedAt) < Date.now() - hoursOld * 3_600_000;
}

/* ------------------------------------------------------------------ */
/* Workable                                                            */
/* ------------------------------------------------------------------ */

const WORKABLE_PAGES = 3;

const WORKPLACE: Record<string, Job["workMode"]> = { remote: "remote", hybrid: "hybrid", on_site: "office", onsite: "office" };

export function normalizeWorkable(raw: unknown): Job | null {
  const job = record(raw);
  if (!job || (str(job["state"]) ?? "published") !== "published") return null;
  const title = str(job["title"]);
  const company = str(record(job["company"])?.["title"]);
  const url = str(job["url"]);
  if (!title || !company || !url) return null;
  const place = record(job["location"]);
  const country = str(place?.["countryName"]);
  const location = [str(place?.["city"]), country].filter(Boolean).join(", ") || null;
  const workMode = WORKPLACE[str(job["workplace"]) ?? ""] ?? null;
  const body = ["description", "requirementsSection", "benefitsSection"]
    .map((field) => str(job[field]) ?? "")
    .join("\n");
  return {
    source: "workable",
    externalId: str(job["id"]) ?? url,
    title,
    company,
    url,
    location,
    remote: workMode === "remote",
    workMode,
    salary: null,
    salaryMin: null,
    salaryMax: null,
    tags: [str(job["department"]), str(job["employmentType"])].filter((tag): tag is string => tag !== null),
    // `created`, not `updated`: a posting kept open for a year is a year old.
    postedAt: str(job["created"]),
    // The country the role is listed in. Remote within it, as on company boards.
    locationRestrictions: country ? [country] : [],
    description: htmlToText(body).slice(0, TEXT_CAP) || null,
  };
}

/**
 * One term after another, up to three pages each. Workable's location filter
 * matches the country a role is listed in: "Poland" with remote is roles
 * listed for remote work from Poland. "Europe" returns 376 rows for react,
 * nearly all of them remote within one other country.
 */
export async function fetchWorkable(options: Pick<FetchOptions, "hoursOld"> = {}): Promise<Job[]> {
  const jobs = new Map<string, Job>();
  const failures: string[] = [];
  for (const query of WORKABLE_QUERIES) {
    let token: string | null = null;
    for (let page = 0; page < WORKABLE_PAGES; page++) {
      const params = new URLSearchParams({ query, location: "Poland", workplace: "remote" });
      if (token) params.set("pageToken", token);
      let payload: Raw | null;
      try {
        payload = record(await fetchJson(`https://jobs.workable.com/api/v1/jobs?${params.toString()}`));
      } catch (error) {
        failures.push(`"${query}": ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
      const rows = Array.isArray(payload?.["jobs"]) ? (payload["jobs"] as unknown[]) : [];
      for (const row of rows) {
        const job = normalizeWorkable(row);
        if (job && !tooOld(job.postedAt, options.hoursOld)) jobs.set(job.externalId, job);
      }
      token = str(payload?.["nextPageToken"]);
      if (!token || rows.length === 0) break;
    }
  }
  if (jobs.size === 0 && failures.length > 0) throw new Error(failures.join("; "));
  if (failures.length > 0) console.error(`workable: ${failures.join("; ")}`);
  return [...jobs.values()];
}

/* ------------------------------------------------------------------ */
/* Jobicy                                                              */
/* ------------------------------------------------------------------ */

const JOBICY_PAGES = 3;
const JOBICY_UNIT: Record<string, PayRange["unit"]> = { hourly: "hour", daily: "day", monthly: "month", yearly: "year", annual: "year" };

/**
 * One posting of jobicy.com's API. Its terms ask for a credit and a link to the
 * posting: the card's link is the Jobicy page, and its board name is Jobicy.
 */
export function normalizeJobicy(raw: unknown): Job | null {
  const job = record(raw);
  if (!job) return null;
  const title = str(job["jobTitle"]);
  const company = str(job["companyName"]);
  const url = str(job["url"]);
  if (!title || !company || !url) return null;
  // "Canada,  Poland,  UK,  USA", "Europe", "Anywhere"
  const geo = [job["jobGeo"]].flat().flatMap((value) => String(value ?? "").split(",")).map((place) => place.trim()).filter(Boolean);
  const min = typeof job["salaryMin"] === "number" ? job["salaryMin"] : null;
  const max = typeof job["salaryMax"] === "number" ? job["salaryMax"] : null;
  const currency = str(job["salaryCurrency"]);
  const pay: PayRange[] =
    currency && (min || max)
      ? [{ contract: "other", min, max, currency, unit: JOBICY_UNIT[str(job["salaryPeriod"]) ?? "yearly"] ?? "year", gross: false }]
      : [];
  return {
    source: "jobicy",
    externalId: String(job["id"] ?? url),
    title: decodeNumeric(htmlToText(title)),
    company: decodeNumeric(htmlToText(company)),
    url,
    location: geo.join(", ") || null,
    remote: true, // Jobicy is a remote-only board.
    workMode: "remote",
    ...payFields(pay),
    tags: [job["jobIndustry"], job["jobType"]].flat().map(str).filter((tag): tag is string => tag !== null),
    seniorityLevel: str(job["jobLevel"]),
    postedAt: str(job["pubDate"]),
    // The countries or regions it is open to: what eligibility.ts reads.
    locationRestrictions: geo,
    description: decodeNumeric(htmlToText(str(job["jobDescription"]) ?? "")).slice(0, TEXT_CAP) || null,
  };
}

/**
 * Engineering roles open to Poland: geo=poland returns those listing Poland,
 * Europe, EMEA or anywhere (61 on 2026-10-30), up to 100 a page.
 */
export async function fetchJobicy(): Promise<Job[]> {
  const jobs = new Map<string, Job>();
  let cursor: string | null = null;
  for (let page = 0; page < JOBICY_PAGES; page++) {
    const params = new URLSearchParams({ count: "100", geo: "poland", industry: "dev" });
    if (cursor) params.set("cursor", cursor);
    const payload = record(await fetchJson(`https://jobicy.com/api/v2/remote-jobs?${params.toString()}`));
    const rows = Array.isArray(payload?.["jobs"]) ? (payload["jobs"] as unknown[]) : [];
    for (const row of rows) {
      const job = normalizeJobicy(row);
      if (job) jobs.set(job.url, job);
    }
    cursor = str(payload?.["nextCursor"]);
    if (payload?.["hasMore"] !== true || !cursor || rows.length === 0) break;
  }
  if (jobs.size === 0) throw new Error("no postings in the answer");
  return [...jobs.values()];
}

/* ------------------------------------------------------------------ */
/* Hacker News: "Ask HN: Who is hiring?"                               */
/* ------------------------------------------------------------------ */

/*
 * A post opens with a header line by convention, not by rule:
 *   "eventfirst | Senior Full-Stack Engineer | Berlin, Germany | REMOTE (CET) | Full-time"
 *   "PrairieLearn (Remote US) — Full-Stack Software Engineer — TypeScript / Postgres / React / AI"
 * Company first, then the role, places and terms in any order.
 */
const SEPARATOR = /^(?:\s+[|•·—–]\s+|\s*\|\s*)/;
const URL = /https?:\/\/\S+|\b[\w-]+\.(?:com|io|ai|co|app|dev|xyz|org|net|so)\b\S*/gi;
const ROLE = /\b(?:engineers?|engineering|developers?|programmers?|swes?|front[- ]?end|full[- ]?stack|back[- ]?end|architects?|cto|tech lead)\b/i;
/** A role's noun: "full-stack" alone is not a title. */
const ROLE_NOUN = /\b(?:engineers?|engineering|developers?|programmers?|swes?|architects?|cto|lead)\b/i;
/** The roles worth naming first when a post lists several. */
const TARGET_ROLE = /\b(?:front[- ]?end|full[- ]?stack|react|typescript|next\.?js|web|product engineers?|ui engineers?|javascript)\b/i;
const PLACE = /\b(?:remote|onsite|on-site|in[- ]office|in[- ]person|hybrid|anywhere|worldwide|global(?:ly)?|relocation)\b/i;
const CITY_COUNTRY = /\b[A-Z][a-z]+,\s*(?:[A-Z]{2}\b|[A-Z][a-z]+)/;
const TERMS = /\b(?:full[- ]?time|part[- ]?time|contract(?:or)?|freelance|permanent|intern(?:ship)?|visa|equity|salary)\b|[$€£]\s?\d|\d\s?k\b/i;
const CLOSED = /\b(?:closed|no longer hiring|position (?:has been )?filled)\b/i;

export type HnPost = { id: number | string; created_at?: string | null; text?: string | null };

/** HN writes "/" and "'" as &#x2F; and &#x27;, which htmlToText leaves alone. */
function decodeNumeric(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)));
}

/** Split where `separator` matches outside parentheses: "Engineers (Senior, Staff)" stays whole. */
function splitTop(text: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[") depth++;
    else if ((ch === ")" || ch === "]") && depth > 0) depth--;
    else if (depth === 0) {
      const hit = separator.exec(text.slice(i));
      if (hit && hit[0].length > 0) {
        parts.push(text.slice(start, i));
        i += hit[0].length - 1;
        start = i + 1;
      }
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function roleIn(segment: string): string | null {
  // "Senior Product Engineer, Product Manager, Senior Sales Engineer" — the
  // roles one by one; the one I would apply to first.
  const roles = splitTop(segment, /^\s*(?:,|;|&|\+|\/(?=\s)|\band\b)\s*/i).filter((role) => ROLE.test(role));
  const role = roles.find((candidate) => TARGET_ROLE.test(candidate)) ?? roles[0] ?? null;
  if (!role) return null;
  return ROLE_NOUN.test(role) ? role : `${role} engineer`;
}

/**
 * One post as a job, or null when it is no role (a reply, a closed post, a
 * header naming no engineering role). The title is the role from the header;
 * the place is every header part that says remote, onsite or a region.
 */
export function parseHackerNewsPost(post: HnPost): Job | null {
  const html = str(post.text);
  if (!html) return null;
  const text = decodeNumeric(htmlToText(html.replace(/<p>/gi, "\n<p>")));
  const header = text.split("\n")[0]?.trim() ?? "";
  if (header.length < 8 || CLOSED.test(header)) return null;
  const segments = splitTop(header, SEPARATOR);
  // "Modash.io | Senior Product Engineer | …": the company as its domain.
  const domain = /^(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+)\.[a-z]{2,}(?:\.[a-z]{2,})?\/?$/i.exec(segments[0] ?? "")?.[1];
  const company = domain
    ? domain.charAt(0).toUpperCase() + domain.slice(1)
    : (segments[0] ?? "")
        .replace(URL, "")
        .replace(/\((?:[^)]*(?:remote|yc\b|series|founded)[^)]*)\)/gi, "")
        .replace(/[\s(),:-]+$/, "")
        .trim();
  // A header that opens with the role names no company ("Software Engineer — Remote — US Only").
  if (!company || company.length > 60 || /^location\b/i.test(company) || ROLE.test(company)) return null;
  const rest = segments.slice(1).map((segment) => segment.replace(URL, "").trim()).filter(Boolean);
  const title =
    rest.map(roleIn).find((role): role is string => role !== null && !PLACE.test(role)) ?? roleIn(segments[0] ?? "");
  if (!title) return null;
  const places = rest.filter(
    (segment) =>
      (PLACE.test(segment) || REGION_OPEN.test(segment) || REGION_AMERICAS.test(segment) || CITY_COUNTRY.test(segment)) &&
      !TERMS.test(segment) &&
      !ROLE.test(segment),
  );
  // Remote said in the header, or "(Remote US)" beside the company name.
  const head = [header, text.slice(header.length, header.length + 400)].join(" ");
  const remote = /\bremote\b|\banywhere\b|\bdistributed\b/i.test(head);
  const officeOnly = !remote && /\b(?:onsite|on-site|in[- ]office|in[- ]person|hybrid)\b/i.test(header);
  const id = String(post.id);
  return {
    source: "hackernews",
    externalId: id,
    title: title.slice(0, 120),
    company,
    url: `https://news.ycombinator.com/item?id=${id}`,
    location: places.join(" · ").slice(0, 160) || (/\(([^)]*remote[^)]*)\)/i.exec(header)?.[1] ?? null),
    remote,
    workMode: remote ? "remote" : officeOnly ? (/hybrid/i.test(header) ? "hybrid" : "office") : null,
    salary: null,
    salaryMin: null,
    salaryMax: null,
    tags: [],
    postedAt: str(post.created_at),
    // The header's places, for eligibility.ts: Europe, worldwide, US only…
    locationRestrictions: [header.slice(0, 300)],
    // The whole post is the posting: Claude reads this, not the thread's page.
    description: text.slice(0, TEXT_CAP),
  };
}

/**
 * The latest "Who is hiring?" thread, every top-level post in it. The whole
 * thread is listed until the next one appears (the first weekday of a month),
 * so a post stays while its thread is current.
 */
export async function fetchHackerNews(): Promise<Job[]> {
  const search = record(
    await fetchJson("https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10"),
  );
  const hits = Array.isArray(search?.["hits"]) ? (search["hits"] as unknown[]) : [];
  const thread = hits.map(record).find((hit) => /^Ask HN: Who is hiring\?/i.test(str(hit?.["title"]) ?? ""));
  const id = str(thread?.["objectID"]);
  if (!id) throw new Error("no \"Who is hiring?\" thread found");
  const item = record(await fetchJson(`https://hn.algolia.com/api/v1/items/${id}`));
  const posts = Array.isArray(item?.["children"]) ? (item["children"] as HnPost[]) : [];
  if (posts.length === 0) throw new Error(`thread ${id} has no posts`);
  // Most of a thread is onsite in San Francisco or remote within the US: kept
  // out of the store, as the watchlist keeps out its tax leads.
  return posts
    .map(parseHackerNewsPost)
    .filter((job): job is Job => job !== null && fitTier(job) <= 2 && scoreEligibility(job).level !== "low");
}
