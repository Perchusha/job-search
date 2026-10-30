/**
 * boards-ua.ts — the Ukrainian IT board jobs.dou.ua.
 *
 * Added on 2026-10-30, when I asked for Belarusian and Ukrainian boards rather
 * than Russian ones. The Belarusian ones turned out empty: jobs.devby.io
 * listed 6 vacancies for the whole country, and rabota.by is hh.ru, whose API
 * answers 403 without a registered app. jobs.dou.ua has RSS feeds per
 * category and city, 25 latest each, with the whole text. The title says
 * where: "віддалено" (remote), "за кордоном" (from abroad), "Варшава (Польща)".
 *
 * djinni.co was read here too and was removed the same day: Djinni blocked my
 * account, so its postings could not be applied to.
 *
 * Read once per pass (PER_PASS_SOURCES). Postings closed to Poland (Ukraine
 * only, an office in Kyiv) are not stored. A pass that finds nothing throws,
 * so a changed feed shows up as a failed board rather than as silence.
 */

import { payFields } from "./boards-pl.ts";
import { scoreEligibility } from "./eligibility.ts";
import { DOU_FEEDS, fitTier } from "./profile.ts";
import type { Job, PayRange } from "./sources.ts";
import { htmlToText } from "./watchlist.ts";

const USER_AGENT = "job-hunt-mcp";
const REQUEST_TIMEOUT_MS = 20_000;
const TEXT_CAP = 8000;

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
