/**
 * watchlist.ts — chosen companies' own job boards, read through their ATS's
 * public API (Greenhouse, Lever, Ashby). No scraping, no key: these endpoints
 * exist so companies can embed their board anywhere.
 *
 * Why: a product company that hires remote in Poland posts a role on its own
 * board first, and often never on Indeed. Measured on 2026-10-23, 22 boards
 * gave ~9 fitting roles, 5 of them never seen through any other source —
 * among them Elastic's Poland full-stack role with a published PLN range.
 *
 * The list is personal and lives in profile.ts (WATCHLIST). A board that
 * answers 404 is reported in the source's skip note, so dead entries show up.
 *
 * Postings carry no postedAt on purpose: a company board lists what is open,
 * and "Senior Fullstack Engineer, posted 2021" on Linear's board is an open,
 * evergreen role. Its age is when this tool first saw it.
 */

import { scoreEligibility } from "./eligibility.ts";
import { fitTier, SEARCH_DEFAULTS, WATCHLIST, type WatchedBoard } from "./profile.ts";
import type { Job, PayRange } from "./sources.ts";

const USER_AGENT = "job-hunt-mcp";
const REQUEST_TIMEOUT_MS = 30_000;
/** Boards fetched at once; one request per board. */
const CONCURRENCY = 4;

type Raw = Record<string, unknown>;

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

/** Plain text from an HTML body (Greenhouse sends it entity-escaped). Himalayas uses it too. */
export function htmlToText(html: string): string {
  return html
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h\d|br)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

const REMOTE = /\bremote\b|\banywhere\b|\bdistributed\b/i;
const ENGINEERING_TITLE = /\b(?:engineer|developer|programmer|programista|front[- ]?end|full[- ]?stack|web)\b/i;

function job(board: WatchedBoard, fields: Omit<Job, "source" | "company" | "postedAt" | "salary" | "salaryMin" | "salaryMax"> & { pay: PayRange[] }): Job {
  const range = fields.pay[0];
  return {
    source: "watchlist",
    company: board.company,
    postedAt: null,
    salary: range
      ? `${range.currency} ${Math.round((range.min ?? range.max ?? 0) / 1000)}k–${Math.round((range.max ?? range.min ?? 0) / 1000)}k / ${range.unit}`
      : null,
    salaryMin: range?.min ?? null,
    salaryMax: range?.max ?? null,
    ...fields,
  };
}

function ashby(board: WatchedBoard, payload: Raw): Job[] {
  return ((payload["jobs"] ?? []) as Raw[]).flatMap((raw) => {
    const title = str(raw["title"]);
    const url = str(raw["jobUrl"]);
    if (!title || !url || raw["isListed"] === false) return [];
    const locations = [
      str(raw["location"]),
      ...((raw["secondaryLocations"] ?? []) as Raw[]).map((entry) => str(entry["location"])),
    ].filter((value): value is string => value !== null);
    const salary = (((raw["compensation"] as Raw | undefined)?.["summaryComponents"] ?? []) as Raw[]).find(
      (component) => component["compensationType"] === "Salary",
    );
    const pay: PayRange[] =
      salary && (num(salary["minValue"]) || num(salary["maxValue"]))
        ? [{
            contract: "other",
            min: num(salary["minValue"]),
            max: num(salary["maxValue"]),
            currency: str(salary["currencyCode"]) ?? "USD",
            unit: /hour/i.test(String(salary["interval"])) ? "hour" : /month/i.test(String(salary["interval"])) ? "month" : "year",
            gross: false,
          }]
        : [];
    const remote = raw["isRemote"] === true || raw["workplaceType"] === "Remote";
    return [job(board, {
      externalId: str(raw["id"]) ?? url,
      title,
      url,
      location: locations.join("; ") || null,
      remote,
      pay,
      tags: [str(raw["department"]), str(raw["team"]), str(raw["employmentType"])].filter((v): v is string => v !== null),
      locationRestrictions: locations,
      description: (str(raw["descriptionPlain"]) ?? "").slice(0, 8000) || null,
      workMode: remote ? "remote" : raw["workplaceType"] === "Hybrid" ? "hybrid" : null,
    })];
  });
}

function greenhouse(board: WatchedBoard, payload: Raw): Job[] {
  return ((payload["jobs"] ?? []) as Raw[]).flatMap((raw) => {
    const title = str(raw["title"]);
    const url = str(raw["absolute_url"]);
    if (!title || !url) return [];
    const location = str((raw["location"] as Raw | undefined)?.["name"]);
    const offices = ((raw["offices"] ?? []) as Raw[]).map((office) => str(office["name"])).filter((v): v is string => v !== null);
    const ranges = (raw["pay_input_ranges"] ?? []) as Raw[];
    const pay: PayRange[] = ranges.slice(0, 1).flatMap((range) => {
      const min = num(range["min_cents"]);
      const max = num(range["max_cents"]);
      if (!min && !max) return [];
      return [{
        contract: "other" as const,
        min: min ? min / 100 : null,
        max: max ? max / 100 : null,
        currency: str(range["currency_type"]) ?? "USD",
        unit: "year" as const,
        gross: false,
      }];
    });
    // The posting's own location decides; offices ("EMEA") are org groupings
    // and would make a London-only role look open to Poland.
    const locations = location ? [location] : offices;
    const content = str(raw["content"]);
    return [job(board, {
      externalId: String(raw["id"] ?? url),
      title,
      url,
      location: location ?? (offices.join("; ") || null),
      remote: REMOTE.test(locations.join(" ")),
      pay,
      tags: ((raw["departments"] ?? []) as Raw[]).map((d) => str(d["name"])).filter((v): v is string => v !== null),
      locationRestrictions: locations,
      description: content ? htmlToText(content).slice(0, 8000) : null,
      workMode: REMOTE.test(locations.join(" ")) ? "remote" : null,
    })];
  });
}

function lever(board: WatchedBoard, payload: unknown): Job[] {
  return (Array.isArray(payload) ? (payload as Raw[]) : []).flatMap((raw) => {
    const title = str(raw["text"]);
    const url = str(raw["hostedUrl"]);
    if (!title || !url) return [];
    const categories = (raw["categories"] ?? {}) as Raw;
    const locations = ((categories["allLocations"] ?? [categories["location"]]) as unknown[])
      .map(str)
      .filter((value): value is string => value !== null);
    const salary = raw["salaryRange"] as Raw | undefined;
    const pay: PayRange[] =
      salary && (num(salary["min"]) || num(salary["max"]))
        ? [{
            contract: "other",
            min: num(salary["min"]),
            max: num(salary["max"]),
            currency: str(salary["currency"]) ?? "USD",
            unit: /hour/i.test(String(salary["interval"])) ? "hour" : /month/i.test(String(salary["interval"])) ? "month" : "year",
            gross: false,
          }]
        : [];
    const workplace = str(raw["workplaceType"]);
    return [job(board, {
      externalId: str(raw["id"]) ?? url,
      title,
      url,
      location: locations.join("; ") || null,
      remote: workplace === "remote" || REMOTE.test(locations.join(" ")),
      pay,
      tags: [str(categories["team"]), str(categories["commitment"])].filter((v): v is string => v !== null),
      locationRestrictions: locations,
      description: (str(raw["descriptionPlain"]) ?? "").slice(0, 8000) || null,
      workMode: workplace === "remote" ? "remote" : workplace === "hybrid" ? "hybrid" : workplace === "onsite" ? "office" : null,
    })];
  });
}

const ENDPOINT: Record<WatchedBoard["vendor"], (board: string) => string> = {
  ashby: (board) => `https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`,
  greenhouse: (board) => `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true&pay_transparency=true`,
  lever: (board) => `https://api.lever.co/v0/postings/${board}?mode=json`,
};

async function fetchBoard(board: WatchedBoard): Promise<Job[]> {
  const response = await fetch(ENDPOINT[board.vendor](board.board), {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${board.vendor}/${board.board}: HTTP ${response.status}`);
  const payload = (await response.json()) as unknown;
  if (board.vendor === "ashby") return ashby(board, payload as Raw);
  if (board.vendor === "greenhouse") return greenhouse(board, payload as Raw);
  return lever(board, payload);
}

/**
 * Every watched board. A dead board does not fail the source; it is named in
 * the error only when every board failed (see sources.ts fetchAllSources).
 */
export async function fetchWatchlist(boards: readonly WatchedBoard[] = WATCHLIST): Promise<Job[]> {
  const jobs: Job[] = [];
  const failures: string[] = [];
  for (let start = 0; start < boards.length; start += CONCURRENCY) {
    const batch = boards.slice(start, start + CONCURRENCY);
    const results = await Promise.allSettled(batch.map((board) => fetchBoard(board)));
    results.forEach((result) => {
      if (result.status === "fulfilled") jobs.push(...result.value);
      else failures.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
    });
  }
  if (jobs.length === 0 && failures.length > 0) throw new Error(failures.join("; "));
  if (failures.length > 0) console.error(`watchlist: ${failures.join("; ")}`);
  // A company board lists every role it has — GitLab and Elastic hundreds, tax
  // leads and transcription freelancers included, with long descriptions that
  // score on generic terms. Keep engineering titles the search could show, so
  // the store holds roles, not catalogues.
  return jobs.filter(
    (job) =>
      ENGINEERING_TITLE.test(job.title) &&
      fitTier(job) <= SEARCH_DEFAULTS.maxFitTier &&
      scoreEligibility(job).level !== "low",
  );
}
