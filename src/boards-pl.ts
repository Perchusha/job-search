/**
 * boards-pl.ts — the two Polish IT boards: nofluffjobs.com and justjoin.it.
 *
 * They are where the local market is, and they publish what Indeed and
 * LinkedIn never do: a salary range per contract type (B2B / UoP), an explicit
 * remote flag and the seniority level. Measured on 2026-10-23: NoFluffJobs
 * returned 62 remote senior React postings in one request, 60 with pay;
 * justjoin.it 86 remote senior JavaScript offers in two. Most of the relevant
 * ones were in neither Indeed nor Himalayas.
 *
 * Both boards' JSON APIs are disallowed in their robots.txt (api.justjoin.it:
 * `Disallow: /`; nofluffjobs: `/api/`), while the public listing pages are
 * allowed, so these read the data those pages embed:
 *   - nofluffjobs: Angular's `<script id="serverApp-state">` JSON
 *   - justjoin.it: the Next.js RSC flight chunks (`self.__next_f.push`)
 * Both are undocumented page internals. A parse that finds nothing throws, so a
 * board redesign shows up as a skipped source rather than as silence.
 *
 * Fetched once per pass, not once per TARGET_QUERY: the listing URL already
 * encodes remote + senior + stack, so repeating it per query would download the
 * same 1.5 MB page ten times. See PER_PASS_SOURCES in sources.ts.
 */

import { POLISH_BOARDS, SALARY } from "./profile.ts";
import type { Job, PayRange } from "./sources.ts";

const USER_AGENT = "job-hunt-mcp";
const REQUEST_TIMEOUT_MS = 20_000;

async function fetchPage(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`network error (${error instanceof Error ? error.message : String(error)})`);
  }
  if (response.status === 429) throw new Error("rate limited (HTTP 429)");
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.text();
}

/* ------------------------------------------------------------------ */
/* Pay                                                                 */
/* ------------------------------------------------------------------ */

const HOURS_PER_MONTH = 168;
const DAYS_PER_MONTH = 21;

/**
 * One comparable number per range: PLN per month, B2B-equivalent. UoP is
 * quoted gross, so it is scaled up to what the same cost looks like on an
 * invoice (SALARY.uopToB2b). Used only to sort and filter; cards show the
 * original figures.
 */
export function payB2bPlnMonth(pay: PayRange[]): { min: number | null; max: number | null } | null {
  let min: number | null = null;
  let max: number | null = null;
  for (const range of pay) {
    const fx = SALARY.fxToPln[range.currency.toUpperCase()];
    if (fx === undefined) continue;
    const perMonth =
      range.unit === "hour"
        ? HOURS_PER_MONTH
        : range.unit === "day"
          ? DAYS_PER_MONTH
          : range.unit === "year"
            ? 1 / 12
            : 1;
    const contract = range.contract === "uop" ? SALARY.uopToB2b : 1;
    const scale = fx * perMonth * contract;
    if (range.min !== null) min = Math.max(min ?? 0, range.min * scale);
    if (range.max !== null) max = Math.max(max ?? 0, range.max * scale);
  }
  return min === null && max === null ? null : { min, max };
}

/**
 * True only when a posting publishes pay and even its top is under the floor.
 * Unknown pay is never "below": most boards publish none.
 */
export function belowSalaryFloor(job: Job): boolean {
  if (!job.pay || job.pay.length === 0) return false;
  const monthly = payB2bPlnMonth(job.pay);
  const top = monthly?.max ?? monthly?.min ?? null;
  return top !== null && top < SALARY.floorB2bPlnMonth;
}

const CONTRACT_LABEL: Record<PayRange["contract"], string> = {
  b2b: "B2B",
  uop: "UoP",
  mandate: "UZ",
  other: "",
};
const UNIT_LABEL: Record<PayRange["unit"], string> = { hour: "/h", day: "/day", month: "/mo", year: "/yr" };

function compact(amount: number): string {
  return amount >= 1000 ? `${Number((amount / 1000).toFixed(1))}k` : String(Math.round(amount));
}

/** "B2B 24k–28k PLN/mo · UoP 20k–26k PLN/mo gross" */
export function formatPay(pay: PayRange[]): string | null {
  const parts = pay
    .filter((range) => range.min !== null || range.max !== null)
    .map((range) => {
      const amounts =
        range.min !== null && range.max !== null && range.min !== range.max
          ? `${compact(range.min)}–${compact(range.max)}`
          : compact((range.min ?? range.max) as number);
      return [
        CONTRACT_LABEL[range.contract],
        `${amounts} ${range.currency}${UNIT_LABEL[range.unit]}`,
        range.gross && range.contract === "uop" ? "gross" : "",
      ]
        .filter(Boolean)
        .join(" ");
    });
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** The pay fields of a Job, from its ranges. salaryMin/Max: annual PLN, B2B-equivalent. */
function payFields(pay: PayRange[]): Pick<Job, "pay" | "salary" | "salaryMin" | "salaryMax"> {
  const monthly = payB2bPlnMonth(pay);
  return {
    pay,
    salary: formatPay(pay),
    salaryMin: monthly?.min != null ? Math.round(monthly.min * 12) : null,
    salaryMax: monthly?.max != null ? Math.round(monthly.max * 12) : null,
  };
}

function unitOf(value: unknown): PayRange["unit"] {
  const unit = String(value ?? "").toLowerCase();
  return unit === "hour" || unit === "day" || unit === "year" ? unit : "month";
}

function contractOf(value: unknown): PayRange["contract"] {
  const type = String(value ?? "").toLowerCase();
  if (type === "b2b") return "b2b";
  if (type === "permanent" || type === "uop") return "uop";
  if (type.includes("mandate")) return "mandate";
  return "other";
}

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/* ------------------------------------------------------------------ */
/* nofluffjobs.com                                                     */
/* ------------------------------------------------------------------ */

type Record_ = Record<string, unknown>;

/** The postings embedded in a listing page (the suggestions block is ignored). */
export function parseNoFluffPage(html: string): Record_[] {
  const match = html.match(/<script id="serverApp-state" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("no serverApp-state on the page — layout changed?");
  // Angular escapes the transfer state on some builds.
  const raw = match[1].includes("&q;")
    ? match[1]
        .replace(/&q;/g, '"')
        .replace(/&s;/g, "'")
        .replace(/&l;/g, "<")
        .replace(/&g;/g, ">")
        .replace(/&a;/g, "&")
    : match[1];
  const state = JSON.parse(raw) as Record_;
  // The entry's key is a per-query hash, so find it by shape.
  for (const value of Object.values(state)) {
    if (value && typeof value === "object" && Array.isArray((value as Record_)["postings"])) {
      return (value as { postings: Record_[] }).postings;
    }
  }
  throw new Error("serverApp-state has no postings — layout changed?");
}

export function normalizeNoFluff(posting: Record_): Job | null {
  const title = str(posting["title"]);
  const company = str(posting["name"]);
  const slug = str(posting["url"]);
  if (!title || !company || !slug) return null;

  const places = ((posting["location"] as Record_ | undefined)?.["places"] ?? []) as Record_[];
  const remote =
    posting["fullyRemote"] === true || places.some((place) => place["city"] === "Remote");
  const cities = places
    .map((place) => str(place["city"]))
    .filter((city): city is string => city !== null && city !== "Remote");

  const salary = posting["salary"] as Record_ | undefined;
  const pay: PayRange[] =
    salary && (num(salary["from"]) !== null || num(salary["to"]) !== null)
      ? [
          {
            contract: contractOf(salary["type"]),
            min: num(salary["from"]),
            max: num(salary["to"]),
            currency: str(salary["currency"]) ?? "PLN",
            unit: unitOf(salary["period"]),
            gross: contractOf(salary["type"]) === "uop",
          },
        ]
      : [];

  const tiles = (((posting["tiles"] as Record_ | undefined)?.["values"] ?? []) as Record_[])
    .filter((tile) => tile["type"] === "requirement")
    .map((tile) => str(tile["value"]))
    .filter((value): value is string => value !== null);
  const seniority = (Array.isArray(posting["seniority"]) ? posting["seniority"] : []) as string[];
  const posted = num(posting["posted"]);

  return {
    source: "nofluffjobs",
    externalId: str(posting["id"]) ?? slug,
    title,
    company,
    url: `https://nofluffjobs.com/pl/job/${slug}`,
    location: remote ? "Remote, PL" : cities.length > 0 ? `${cities.join(", ")}, PL` : "Poland",
    remote,
    ...payFields(pay),
    tags: [...new Set([...tiles, ...seniority])],
    // `posted` is the publication date; `renewed` is a bump and would make
    // every reposted role look new.
    postedAt: posted !== null ? new Date(posted).toISOString() : null,
    locationRestrictions: ["Poland"],
    workMode: remote ? "remote" : null,
    seniorityLevel: seniority.join("/") || null,
  };
}

export async function fetchNoFluffJobs(): Promise<Job[]> {
  const pages = await Promise.all(POLISH_BOARDS.nofluffjobs.map((url) => fetchPage(url)));
  return pages
    .flatMap((html) => parseNoFluffPage(html))
    .map((posting) => normalizeNoFluff(posting))
    .filter((job): job is Job => job !== null);
}

/* ------------------------------------------------------------------ */
/* justjoin.it                                                         */
/* ------------------------------------------------------------------ */

/** Every `self.__next_f.push([1,"…"])` string on the page, decoded and joined. */
function flightText(html: string): string {
  const pattern = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let text = "";
  for (const match of html.matchAll(pattern)) text += JSON.parse(match[1] as string) as string;
  return text;
}

/** Index of the bracket that closes the one at `start`, skipping strings. */
function closingIndex(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The offer objects in a listing page: every object that carries its own "guid". */
export function parseJustJoinPage(html: string): Record_[] {
  const text = flightText(html);
  if (text.length === 0) throw new Error("no Next.js flight data on the page — layout changed?");
  const offers = new Map<string, Record_>();
  for (const match of text.matchAll(/"guid":"([0-9a-f-]{36})"/g)) {
    const guid = match[1] as string;
    if (offers.has(guid)) continue;
    // Walk back to the enclosing object whose own guid this is.
    let attempts = 0;
    for (let index = match.index ?? 0; index >= 0 && attempts < 400; index--) {
      if (text[index] !== "{") continue;
      attempts++;
      const end = closingIndex(text, index);
      if (end < (match.index ?? 0)) continue;
      try {
        const candidate = JSON.parse(text.slice(index, end + 1)) as Record_;
        if (candidate["guid"] === guid) {
          offers.set(guid, candidate);
          break;
        }
      } catch {
        // not a complete JSON object at this brace; keep walking back
      }
    }
  }
  return [...offers.values()];
}

export function normalizeJustJoin(offer: Record_): Job | null {
  const title = str(offer["title"]);
  const company = str(offer["companyName"]);
  const slug = str(offer["slug"]);
  if (!title || !company || !slug) return null;

  const workplace = str(offer["workplaceType"]);
  const workMode = workplace === "remote" ? "remote" : workplace === "hybrid" ? "hybrid" : workplace === "office" ? "office" : null;
  const city = str(offer["city"]);

  // Only the posted figures: the board adds converted copies in GBP/USD/EUR/CHF.
  const pay: PayRange[] = ((offer["employmentTypes"] ?? []) as Record_[])
    .filter((type) => type["currencySource"] !== "conversion")
    .filter((type) => num(type["from"]) !== null || num(type["to"]) !== null)
    .map((type) => ({
      contract: contractOf(type["type"]),
      min: num(type["from"]),
      max: num(type["to"]),
      currency: str(type["currency"]) ?? "PLN",
      unit: unitOf(type["unit"]),
      gross: type["gross"] === true,
    }));

  // publishedAt is bumped on every refresh (85 of 86 offers looked under a week
  // old); the older of the two stamps is the closer guess at the real age.
  const stamps = [str(offer["publishedAt"]), str(offer["lastPublishedAt"])]
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter((value) => Number.isFinite(value));

  return {
    source: "justjoin",
    externalId: str(offer["guid"]) ?? slug,
    title,
    company,
    url: `https://justjoin.it/job-offer/${slug}`,
    location: workMode === "remote" ? "Remote, PL" : city ? `${city}, PL` : "Poland",
    remote: workMode === "remote",
    ...payFields(pay),
    // Required skills only: "nice to have Angular" must not sink a React role.
    tags: [...new Set(((offer["requiredSkills"] ?? []) as unknown[]).map(str).filter((s): s is string => s !== null))],
    postedAt: stamps.length > 0 ? new Date(Math.min(...stamps)).toISOString() : null,
    locationRestrictions: ["Poland"],
    workMode,
    seniorityLevel: str(offer["experienceLevel"]),
  };
}

export async function fetchJustJoin(): Promise<Job[]> {
  const pages = await Promise.all(POLISH_BOARDS.justjoin.map((url) => fetchPage(url)));
  const seen = new Set<string>();
  const jobs: Job[] = [];
  for (const offer of pages.flatMap((html) => parseJustJoinPage(html))) {
    const job = normalizeJustJoin(offer);
    if (!job || seen.has(job.externalId)) continue;
    seen.add(job.externalId);
    jobs.push(job);
  }
  return jobs;
}
