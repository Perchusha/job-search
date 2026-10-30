/**
 * boards-ua.ts — the two Ukrainian IT boards: djinni.co and jobs.dou.ua.
 *
 * Added on 2026-10-30, when I asked for Belarusian and Ukrainian boards rather
 * than Russian ones. The Belarusian ones turned out empty: jobs.devby.io
 * listed 6 vacancies for the whole country, and rabota.by is hh.ru, whose API
 * answers 403 without a registered app. The Ukrainian ones are alive:
 *   - djinni.co: its listing pages (robots.txt allows /jobs/) carry each
 *     posting as JSON-LD with the whole text, the region it is open to and
 *     sometimes pay. React.js, JavaScript and Fullstack gave 168 postings in
 *     a month: 65 open to Europe, 7 to Poland, 31 with no region, 57 in
 *     Ukraine only.
 *   - jobs.dou.ua: RSS feeds per category and city, 25 latest each, with the
 *     whole text. The title says where: "віддалено" (remote), "за кордоном"
 *     (from abroad), "Варшава (Польща)".
 *
 * Both are read once per pass (PER_PASS_SOURCES). Postings closed to Poland
 * (Ukraine only, an office in Kyiv) are not stored. A pass that finds nothing
 * throws, so a changed page shows up as a failed board rather than as silence.
 */

import { payFields } from "./boards-pl.ts";
import { scoreEligibility } from "./eligibility.ts";
import { DJINNI_KEYWORDS, DOU_FEEDS, fitTier } from "./profile.ts";
import type { Job, PayRange } from "./sources.ts";
import { htmlToText } from "./watchlist.ts";

const USER_AGENT = "job-hunt-mcp";
const REQUEST_TIMEOUT_MS = 20_000;
const TEXT_CAP = 8000;

type Raw = Record<string, unknown>;

const str = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
const record = (value: unknown): Raw | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Raw) : null;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchText(url: string, accept: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: accept },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`network error (${error instanceof Error ? error.message : String(error)})`);
  }
  if (response.status === 429) throw new Error("rate limited (HTTP 429)");
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  return response.text();
}

/** Kept only when Poland is in reach and the title is not ruled out, as the watchlist keeps its own. */
function worthStoring(job: Job): boolean {
  return fitTier(job) <= 2 && scoreEligibility(job).level !== "low";
}

/* ------------------------------------------------------------------ */
/* Djinni                                                              */
/* ------------------------------------------------------------------ */

const DJINNI_PAGES = 12;
const DJINNI_PAGE_SIZE = 15;
const UNIT: Record<string, PayRange["unit"]> = { HOUR: "hour", DAY: "day", MONTH: "month", YEAR: "year" };

/** Every JobPosting in a page's JSON-LD blocks. */
export function parseDjinniPage(html: string): Raw[] {
  const postings: Raw[] = [];
  for (const match of html.matchAll(/<script type="application\/ld\+json">([^]*?)<\/script>/g)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1] ?? "");
    } catch {
      continue;
    }
    for (const item of [parsed].flat()) {
      const posting = record(item);
      if (posting?.["@type"] === "JobPosting") postings.push(posting);
    }
  }
  return postings;
}

/** "Europe", "UA", "POL": the regions a posting is open to, from applicantLocationRequirements. */
function djinniRegions(posting: Raw): string[] {
  const areas = [posting["applicantLocationRequirements"]].flat().map(record).filter((area): area is Raw => area !== null);
  return areas
    .map((area) => {
      const address = record(area["address"]);
      return str(address?.["addressRegion"]) ?? str(address?.["addressCountry"]) ?? str(area["name"]);
    })
    .filter((region): region is string => region !== null);
}

export function normalizeDjinni(posting: Raw): Job | null {
  const title = str(posting["title"]);
  const company = str(record(posting["hiringOrganization"])?.["name"]);
  const url = str(posting["url"]);
  if (!title || !company || !url) return null;
  const remote = posting["jobLocationType"] === "TELECOMMUTE";
  const regions = djinniRegions(posting);
  const office = [posting["jobLocation"]]
    .flat()
    .map((place) => record(record(place)?.["address"]))
    .map((address) => [str(address?.["addressLocality"]), str(address?.["addressCountry"])].filter(Boolean).join(", "))
    .filter(Boolean);
  const salary = record(posting["baseSalary"]);
  const value = record(salary?.["value"]);
  const currency = str(salary?.["currency"]);
  const pay: PayRange[] =
    currency && (num(value?.["minValue"]) || num(value?.["maxValue"]))
      ? [{
          contract: "other",
          min: num(value?.["minValue"]),
          max: num(value?.["maxValue"]),
          currency,
          unit: UNIT[str(value?.["unitText"]) ?? "MONTH"] ?? "month",
          gross: false,
        }]
      : [];
  return {
    source: "djinni",
    externalId: str(record(posting["identifier"])?.["value"]) ?? url,
    title,
    company,
    url,
    location: (remote ? regions.join(", ") : office.join("; ")) || null,
    remote,
    workMode: remote ? "remote" : null,
    ...payFields(pay),
    tags: [str(posting["category"]), str(posting["industry"])].filter((tag): tag is string => tag !== null),
    postedAt: str(posting["datePosted"]),
    // Where a remote role may be done from; for an office role, where the office is.
    locationRestrictions: remote ? regions : office,
    description: htmlToText(str(posting["description"]) ?? "").slice(0, TEXT_CAP) || null,
  };
}

/** Each keyword's listing, page after page, until a short page. One second between pages. */
export async function fetchDjinni(): Promise<Job[]> {
  const jobs = new Map<string, Job>();
  const failures: string[] = [];
  for (const keyword of DJINNI_KEYWORDS) {
    for (let page = 1; page <= DJINNI_PAGES; page++) {
      const params = new URLSearchParams({ primary_keyword: keyword });
      if (page > 1) params.set("page", String(page));
      let postings: Raw[];
      try {
        postings = parseDjinniPage(await fetchText(`https://djinni.co/jobs/?${params.toString()}`, "text/html"));
      } catch (error) {
        failures.push(`${keyword} p${page}: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
      for (const posting of postings) {
        const job = normalizeDjinni(posting);
        if (job && worthStoring(job)) jobs.set(job.url, job);
      }
      if (postings.length < DJINNI_PAGE_SIZE) break;
      await pause(1000);
    }
  }
  if (jobs.size === 0 && failures.length > 0) throw new Error(failures.join("; "));
  if (failures.length > 0) console.error(`djinni: ${failures.join("; ")}`);
  return [...jobs.values()];
}

/* ------------------------------------------------------------------ */
/* DOU                                                                 */
/* ------------------------------------------------------------------ */

const unescapeXml = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

function tag(item: string, name: string): string {
  const match = new RegExp(`<${name}[^>]*>([^]*?)</${name}>`).exec(item);
  return match ? unescapeXml((match[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "")).trim() : "";
}

export type DouItem = { title: string; link: string; description: string; pubDate: string };

export function parseDouFeed(xml: string): DouItem[] {
  return [...xml.matchAll(/<item>([^]*?)<\/item>/g)].map((match) => {
    const item = match[1] ?? "";
    return { title: tag(item, "title"), link: tag(item, "link"), description: tag(item, "description"), pubDate: tag(item, "pubDate") };
  });
}

/** A title's tail part that says where or how much, not who: "віддалено", "Київ", "$1900–2200". */
const DOU_TAIL =
  /^(?:віддалено|за кордоном|гібрид|офіс|(?:від|до)?\s*[$€]|\d)|^[А-ЯІЇЄҐ][а-яіїєґ'’]+(?:-[А-ЯІЇЄҐ]?[а-яіїєґ'’]+)*(?: \([А-ЯІЇЄҐ][а-яіїєґ'’ -]+\))?$/;
const POLAND_UA = /Польща|Варшава|Краків|Вроцлав|Гданськ|Познань|Лодзь|Катовіце/;

/**
 * "Senior Frontend Developer (React) в WLTech.AI (WebLab Technology), до $5000, віддалено":
 * the role, the company, then places and pay. The tail is read from the end,
 * so a company with a comma in its name keeps it.
 */
export function normalizeDou(item: DouItem): Job | null {
  // The feed escapes the title twice: "до&amp;nbsp;$5000", "Upload &amp;amp; Stream".
  const title = unescapeXml(item.title).replace(/&nbsp;|\u00a0/g, " ");
  const split = /^(.*?) в (.+)$/.exec(title);
  if (!split) return null;
  const role = (split[1] ?? "").trim();
  const parts = (split[2] ?? "").split(", ");
  const tail: string[] = [];
  while (parts.length > 1 && DOU_TAIL.test(parts[parts.length - 1] ?? "")) tail.unshift(parts.pop() as string);
  const company = parts.join(", ").trim();
  const url = item.link.replace(/[?&]utm_source=jobsrss/, "").replace(/\?$/, "");
  if (!role || !company || !url) return null;
  const places = tail.filter((part) => !/^(?:(?:від|до)?\s*[$€]|\d)/.test(part));
  const money = tail.find((part) => /[$€]/.test(part)) ?? "";
  const amounts = [...money.matchAll(/\d[\d\s]*/g)].map((match) => Number((match[0] ?? "").replace(/\s/g, "")));
  const pay: PayRange[] = amounts.length
    ? [{
        contract: "other",
        min: /^до/.test(money) ? null : (amounts[0] ?? null),
        max: /^від/.test(money) ? null : (amounts[1] ?? (/^до/.test(money) ? amounts[0] ?? null : null)),
        currency: money.includes("€") ? "EUR" : "USD",
        unit: "month",
        gross: false,
      }]
    : [];
  const remote = places.includes("віддалено");
  const posted = new Date(item.pubDate);
  return {
    source: "dou",
    externalId: url,
    title: role,
    company,
    url,
    location: places.join(", ") || null,
    remote,
    workMode: remote ? "remote" : null,
    ...payFields(pay),
    tags: [],
    postedAt: Number.isNaN(posted.getTime()) ? null : posted.toISOString(),
    // "за кордоном" (from abroad), the cities: what eligibility.ts reads.
    locationRestrictions: places.filter((place) => place !== "віддалено"),
    description: htmlToText(item.description).slice(0, TEXT_CAP) || null,
  };
}

/** Every feed in DOU_FEEDS, one after another. */
export async function fetchDou(): Promise<Job[]> {
  const jobs = new Map<string, Job>();
  const failures: string[] = [];
  for (const feed of DOU_FEEDS) {
    try {
      const xml = await fetchText(`https://jobs.dou.ua/vacancies/feeds/?${feed}`, "application/rss+xml");
      for (const item of parseDouFeed(xml)) {
        const job = normalizeDou(item);
        if (job && worthStoring(job)) jobs.set(job.url, job);
      }
    } catch (error) {
      failures.push(`${feed}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await pause(500);
  }
  if (jobs.size === 0 && failures.length > 0) throw new Error(failures.join("; "));
  if (failures.length > 0) console.error(`dou: ${failures.join("; ")}`);
  return [...jobs.values()];
}
