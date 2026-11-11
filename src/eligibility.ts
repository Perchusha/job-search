/**
 * eligibility.ts — "Can I apply to this from Poland?"
 *
 * Residence assumption: Poland (EU). Every normalized Job gets a level:
 *   high   — clearly open to a Poland-based applicant
 *   medium — probably open, but the feed doesn't say enough to be sure
 *   low    — actively excludes Poland (US-only, onsite abroad, ...)
 *
 * find_jobs drops `low` by default. `medium` is deliberately kept: a missing
 * location field is not the same as a rejection.
 *
 * Run `npm run sanity` to execute the checks at the bottom of this file.
 */

import { fitTier, officeAcceptable, stackFit } from "./profile.ts";
import { workSignals } from "./workmode.ts";
import type { Job } from "./sources.ts";

export type Level = "high" | "medium" | "low";

export type Eligibility = {
  eligible: boolean;
  level: Level;
  reason: string;
};

/** Tokens that mean "an EU / Poland-based person may apply". */
const FRIENDLY_TOKENS = [
  "worldwide",
  "anywhere",
  "europe",
  "eu",
  "european union",
  "emea",
  "poland",
  "pl",
  // Polish-language listings (Indeed PL) say "zdalnie" for remote and
  // "Polska" for the country. Scraped locations look like "zdalnie, PL".
  "zdalnie",
  "polska",
] as const;

/** Tokens that, when they are the only geography mentioned, exclude Poland. */
const NORTH_AMERICA_TOKENS = [
  "us",
  "usa",
  "united states",
  "americas",
  "north america",
  "canada",
] as const;

/**
 * Whole-word matching, not substring matching.
 *
 * This matters more than it looks: a naive includes("eu") marks "Deutschland"
 * as EU-friendly, and includes("pl") matches "Naples". Word boundaries keep the
 * short tokens ("eu", "pl") honest while still matching real-world formatting
 * like "EU-only", "Europe/Berlin" or "(EU)".
 */
function matchToken(haystack: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * Polish cities, metro areas and voivodeships: a place in Poland, said without
 * the country. LinkedIn writes "Wroclaw Metropolitan Area", company boards
 * "Warsaw"; read as no-Poland, such a row scored `low` and was never shown.
 */
const POLISH_PLACE =
  /(^|[^a-z0-9ąćęłńóśźż])(warsaw|warszaw\w*|krak[oó]w|cracow|wroc[lł]aw|gda[nń]sk|gdynia|sopot|tricity|tr[oó]jmiasto|pozna[nń]|[lł][oó]d[zź]|katowice|szczecin|lublin|bydgoszcz|bia[lł]ystok|rzesz[oó]w|olsztyn|kielce|opole|toru[nń]|gliwice|silesia|mazowieckie|ma[lł]opolskie|dolno[sś]l[aą]skie|pomorskie|wielkopolskie|[lł][oó]dzkie|[sś]l[aą]skie|lubelskie|podkarpackie|podlaskie|opolskie|lubuskie)([^a-z0-9ąćęłńóśźż]|$)/i;

function firstFriendly(text: string): string | null {
  for (const token of FRIENDLY_TOKENS) {
    if (matchToken(text, token)) return token;
  }
  return POLISH_PLACE.test(text) ? "poland" : null;
}

function mentionsNorthAmerica(text: string): boolean {
  return NORTH_AMERICA_TOKENS.some((token) => matchToken(text, token));
}

/** "Albania, Andorra, Argentina, Australia + 71 more" — keeps reasons readable. */
function summarizeList(values: string[], keep = 4): string {
  const shown = values.slice(0, keep).join(", ");
  const rest = values.length - keep;
  return rest > 0 ? `${shown} + ${rest} more` : shown;
}

/* ------------------------------------------------------------------ */
/* Per-source rules                                                    */
/* ------------------------------------------------------------------ */

/**
 * Himalayas is the only feed with real eligibility metadata:
 * `locationRestrictions` lists the countries the candidate MUST be in, so an
 * empty array genuinely means unrestricted.
 */
function scoreHimalayas(job: Job): Eligibility {
  const restrictions = job.locationRestrictions.filter((country) => country.trim().length > 0);

  if (restrictions.length === 0) {
    // Its timezoneRestrictions (kept among the tags as UTC offsets): a
    // worldwide role that must work American hours is not one for Poland.
    const zones = job.tags.filter((tag) => /^[-+]?\d{1,2}(\.\d+)?$/.test(tag.trim())).map(Number);
    if (zones.length > 0 && !zones.some((zone) => zone >= -1 && zone <= 4)) {
      return {
        eligible: true,
        level: "medium",
        reason: `Open worldwide, but only in UTC${Math.min(...zones) >= 0 ? "+" : ""}${Math.min(...zones)}…${Math.max(...zones)} — Poland is UTC+1/+2`,
      };
    }
    return { eligible: true, level: "high", reason: "No location restriction — open worldwide" };
  }

  const hit = firstFriendly(restrictions.join(", "));
  if (hit) {
    return {
      eligible: true,
      level: "high",
      reason: `Hiring region includes "${hit}" (${summarizeList(restrictions)})`,
    };
  }

  return {
    eligible: false,
    level: "low",
    reason: `Restricted to ${summarizeList(restrictions)} — Poland not listed`,
  };
}

/**
 * RemoteOK exposes only a free-text `location`. Live values range from
 * "Worldwide" to a bare city ("Canberra"), so an unrecognized value scores
 * `medium`, not `low`: the board is mostly worldwide-remote and hiding a
 * possible match is worse than showing a maybe.
 */
function scoreRemoteOk(job: Job): Eligibility {
  const location = (job.location ?? "").trim();

  if (location.length === 0) {
    return { eligible: true, level: "medium", reason: "Remote, region unspecified" };
  }

  const hit = firstFriendly(location);
  if (hit) {
    return { eligible: true, level: "high", reason: `Location "${location}" matches "${hit}"` };
  }

  if (mentionsNorthAmerica(location)) {
    return {
      eligible: false,
      level: "low",
      reason: `Location "${location}" looks North-America-only`,
    };
  }

  return {
    eligible: true,
    level: "medium",
    reason: `Location "${location}" is unclear for a Poland-based applicant — check the posting`,
  };
}

/**
 * Arbeitnow is an EU (mostly German) board. `remote === true` is the strong
 * signal. An onsite role inside Poland is still applicable — just not remote —
 * so it lands at `medium` rather than being dropped.
 */
function scoreArbeitnow(job: Job): Eligibility {
  if (job.remote) {
    return {
      eligible: true,
      level: "high",
      reason: "Remote within the EU — same timezone as Poland",
    };
  }

  const location = (job.location ?? "").trim();

  if (location.length > 0 && firstFriendly(location)) {
    return {
      eligible: true,
      level: "medium",
      reason: `Onsite in "${location}" — reachable from Poland, but not remote`,
    };
  }

  return {
    eligible: false,
    level: "low",
    reason:
      location.length > 0
        ? `Onsite in "${location}" — outside Poland`
        : "Onsite, location unspecified — assume outside Poland",
  };
}

/**
 * JobSpy sources (Indeed, LinkedIn, ...) carry no per-country eligibility
 * metadata — the search itself is scoped by location instead. So the location
 * text is the signal, and because we scope scrapes to Poland, most results are
 * genuinely reachable.
 *
 * Note the residence assumption really matters here: a Poland residence permit
 * (e.g. Blue Card) is not EU-wide work authorisation, so an onsite role in
 * another EU country is still `low` — it would need relocation and a new permit.
 */
/**
 * A LinkedIn card that names only a country or a region ("Poland", "European
 * Union", "EMEA"), or no place at all — JobSpy used to drop exactly those, and
 * the search itself is scoped to Poland. On LinkedIn's remote search such a
 * card is a remote role open to the whole country: 14 of 22 judged so were
 * remote by their text and none asked for an office, while cards naming a
 * city held 17 of the 18 "не remote" skips.
 */
function linkedinCountryWide(job: Job): boolean {
  const location = (job.location ?? "").trim();
  return (
    job.source === "linkedin" &&
    (location.length === 0 || (!location.includes(",") && !POLISH_PLACE.test(location) && firstFriendly(location) !== null))
  );
}

function scoreScraped(job: Job): Eligibility {
  const location = (job.location ?? "").trim();
  if (linkedinCountryWide(job)) {
    return {
      eligible: true,
      level: "high",
      reason: `LinkedIn, remote search, ${location || "Poland"} as a whole — not a city; the text has the last word`,
    };
  }
  const friendly = location.length > 0 ? firstFriendly(location) : null;
  // JobSpy occasionally loses `is_remote` even when the posting itself says
  // "Remote" or the normalized location is literally "zdalnie, PL".
  const explicitlyRemote =
    job.remote || matchToken(location, "zdalnie") || matchToken(job.title, "remote");

  if (explicitlyRemote) {
    // The flag is a substring test for "remote" anywhere in the body; the
    // text can still ask for office days. Then it is a "check", not confirmed.
    const signals = workSignals(job);
    if (signals.mode !== null) {
      return {
        eligible: true,
        level: "medium",
        reason: `Listed as remote, but the posting says ${signals.mode === "onsite" ? "onsite" : "office days"}: «${signals.context}»`,
      };
    }
    // "Remote" on a national board usually means remote *within that country* —
    // a Berlin remote role often requires German tax residency. Only a
    // Poland-or-EU-wide location earns `high`; anything else needs checking.
    return friendly !== null
      ? { eligible: true, level: "high", reason: `Remote, listed for "${location}"` }
      : {
          eligible: true,
          level: "medium",
          reason: `Remote, but listed in "${location}" — confirm it is open to Poland-based candidates`,
        };
  }

  if (friendly !== null) {
    return {
      eligible: true,
      level: "medium",
      reason: `Onsite/hybrid in "${location}" — you live in Poland, but it is not remote`,
    };
  }

  if (location.length === 0) {
    return { eligible: true, level: "medium", reason: "Location not stated — check the posting" };
  }

  return {
    eligible: false,
    level: "low",
    reason: `Onsite in "${location}" — outside Poland, would need relocation and a new permit`,
  };
}

/**
 * Workable's search (src/boards-intl.ts) is asked for remote roles listed in
 * Poland, so the country is the listing's own. Remote there is confirmed,
 * unless the text asks for office days; a role listed in another country is
 * remote within it.
 */
function scoreWorkable(job: Job): Eligibility {
  const country = job.locationRestrictions.join(", ");
  if (!firstFriendly(country)) {
    return { eligible: false, level: "low", reason: `Workable lists it in ${country || "no country"} — remote within it, not Poland` };
  }
  if (!job.remote) {
    return { eligible: true, level: "medium", reason: `${job.workMode === "hybrid" ? "Hybrid" : "Onsite"} in "${job.location ?? country}" — not remote` };
  }
  const signals = workSignals(job);
  if (signals.mode !== null) {
    return { eligible: true, level: "medium", reason: `Listed as remote, but the posting says ${signals.mode === "onsite" ? "onsite" : "office days"}: «${signals.context}»` };
  }
  return { eligible: true, level: "high", reason: `Remote, listed in "${job.location ?? country}" on Workable` };
}

/** Europe, worldwide, a time zone near Poland's: a remote role open to someone in Poland. */
export const REGION_OPEN =
  /\b(?:europe|european|eu|emea|cet|cest|poland|polska|worldwide|anywhere|global(?:ly)?|international|any time ?zone)\b|\b(?:utc|gmt)\s?[+±]/i;
/** The Americas, or their time zones. */
export const REGION_AMERICAS =
  /\b(?:us|usa|u\.s\.?|united states|north america|americas|amer|canada|latam|south america|est|pst|cst|mst)\b/i;

/**
 * Where a remote Hacker News post lets one work from, as its header says
 * (kept in locationRestrictions): Europe or worldwide ("open"), the Americas
 * only, one other country ("Remote (Germany)": "elsewhere"), or nothing said.
 * The header first: a post's body names the US for its office or customers.
 */
export function hackerNewsRegion(
  job: Pick<Job, "locationRestrictions" | "description">,
): "open" | "americas" | "elsewhere" | "unstated" {
  const header = job.locationRestrictions[0] ?? "";
  if (REGION_OPEN.test(header)) return "open";
  if (REGION_AMERICAS.test(header)) return "americas";
  const within = /\bremote\s*[([]\s*([^)\]]+)[)\]]/i.exec(header)?.[1];
  if (within && !/\b(?:preferred|first|friendly|ok)\b/i.test(within)) return "elsewhere";
  const lead = (job.description ?? "").slice(header.length, header.length + 600);
  if (REGION_OPEN.test(lead)) return "open";
  return REGION_AMERICAS.test(lead) ? "americas" : "unstated";
}

/**
 * A "Who is hiring?" post. Its header is all there is: "REMOTE (EU)",
 * "Remote (US only)", "Berlin · ONSITE". Measured on the October 2026
 * thread: 141 of 262 posts remote, 48 of them in the US only.
 */
function scoreHackerNews(job: Job): Eligibility {
  const where = job.location ?? job.locationRestrictions[0]?.slice(0, 80) ?? "";
  if (job.remote) {
    switch (hackerNewsRegion(job)) {
      case "open":
        return { eligible: true, level: "high", reason: `Remote, open to Europe or worldwide ("${where}")` };
      case "americas":
        return { eligible: false, level: "low", reason: `Remote in the Americas only ("${where}")` };
      case "elsewhere":
        return { eligible: false, level: "low", reason: `Remote within another country ("${where}")` };
      default:
        return { eligible: true, level: "medium", reason: `Remote, region not stated ("${where || "—"}") — check the post` };
    }
  }
  if (POLISH_PLACE.test(job.locationRestrictions[0] ?? "")) {
    return { eligible: true, level: "medium", reason: `Office in Poland ("${where}") — not remote` };
  }
  return { eligible: false, level: "low", reason: `Onsite or hybrid ("${where || "—"}") — outside Poland` };
}

/**
 * jobicy.com lists the countries or regions a remote role is open to:
 * "Europe", "Poland", "Anywhere", "Canada, Poland, UK, USA". Asked with
 * geo=poland it returns those; anything else that slips in is out of reach.
 */
function scoreJobicy(job: Job): Eligibility {
  const geo = job.locationRestrictions.join(", ");
  if (firstFriendly(geo) || /\bemea\b/i.test(geo)) return { eligible: true, level: "high", reason: `Remote, open to ${geo}` };
  if (geo === "") return { eligible: true, level: "medium", reason: "Remote, region not stated on Jobicy — check the posting" };
  return { eligible: false, level: "low", reason: `Remote within ${geo} only` };
}

/**
 * jobs.dou.ua's title names where: "віддалено" (remote), "за кордоном" (from
 * abroad), cities. Remote from abroad or in Poland is confirmed; remote alone
 * usually means from Ukraine, so it is a check; an office in Ukraine is out.
 */
function scoreDou(job: Job): Eligibility {
  const places = job.locationRestrictions.join(", ");
  const poland = /Польща|Варшава|Краків|Вроцлав|Гданськ|Познань|Лодзь|Катовіце/.test(places);
  if (job.remote && (poland || places.includes("за кордоном"))) {
    return { eligible: true, level: "high", reason: `Remote, from abroad or Poland (DOU: "${places}")` };
  }
  if (job.remote) return { eligible: true, level: "medium", reason: `Remote, but DOU names no country${places ? ` (${places})` : ""} — often Ukraine only` };
  if (poland) return { eligible: true, level: "medium", reason: `Office in Poland (DOU: "${places}") — not remote` };
  return { eligible: false, level: "low", reason: `Office in "${places || "—"}" — outside Poland` };
}

/**
 * The Polish boards are scoped to Poland by the listing itself, and carry an
 * explicit work-mode field, so the question is only whether it is remote.
 */
function scorePolishBoard(job: Job): Eligibility {
  if (job.workMode === "remote" || job.remote) {
    return { eligible: true, level: "high", reason: "Remote, Polish board" };
  }
  return {
    eligible: true,
    level: "medium",
    reason: `${job.workMode === "hybrid" ? "Hybrid" : "Onsite"} in "${job.location ?? "Poland"}" — you live in Poland, but it is not remote`,
  };
}

/**
 * A company's own board: its location field is the only signal. Poland or a
 * region that includes it is confirmed; a bare "Remote" / "Remote, Global" is
 * a check; any named place without Poland ("Málaga, Spain", "North America",
 * "Remote - Australia") is out of reach, remote or not — remote within a
 * country usually means employed there.
 */
const GENERIC_REMOTE = /^(?:remote|anywhere|worldwide|global|distributed)(?:[\s,()-]*(?:remote|global|worldwide|anywhere))*$/i;

/**
 * The UTC offsets a place names — "Remote (UTC-3 to UTC+3)" is [-3, 3] — and
 * whether they take in Poland's UTC+1: a range that spans it, or one offset
 * within an hour of it. Checkly's EU product role said only this, and was out.
 */
export function zoneCoversPoland(text: string): { from: number; to: number } | null {
  const zones = [...text.matchAll(/\b(?:utc|gmt)\s*([+\-−–])\s*(\d{1,2})(?:[:.](\d{2}))?/gi)]
    .map(([, sign, hours, minutes]) => (sign === "+" ? 1 : -1) * (Number(hours) + Number(minutes ?? 0) / 60));
  if (zones.length === 0) return null;
  const from = Math.min(...zones);
  const to = Math.max(...zones);
  const covers = zones.length > 1 ? from <= 1 && to >= 1 : Math.abs(from - 1) <= 1;
  return covers ? { from, to } : null;
}

function scoreWatchlist(job: Job): Eligibility {
  const places = job.locationRestrictions.join("; ");
  const hit = firstFriendly(places);
  if (hit) return { eligible: true, level: "high", reason: `Company board lists "${hit}" (${places})` };
  const zone = zoneCoversPoland(places);
  if (zone) {
    const utc = (n: number) => `UTC${n >= 0 ? "+" : ""}${n}`;
    return { eligible: true, level: "high", reason: `Company board hires in ${utc(zone.from)}…${utc(zone.to)} (${places}) — Poland is UTC+1/+2` };
  }
  const generic = job.locationRestrictions.every((place) => GENERIC_REMOTE.test(place.trim()));
  if (job.remote && generic) {
    return { eligible: true, level: "medium", reason: `Remote, region not stated ("${places || "—"}") — check the posting` };
  }
  return { eligible: false, level: "low", reason: `Company board lists ${places || "no location"} — Poland not included` };
}

/** Score one job for a Poland-based applicant. */
export function scoreEligibility(job: Job): Eligibility {
  const scored = scoreBySource(job);
  // Not remote is what holds an office role in Warsaw at `medium`; at one of
  // the giants in profile.ts OFFICE_OK that is no reason to doubt it.
  if (scored.level === "medium" && officeAcceptable(job)) {
    return {
      eligible: true,
      level: "high",
      reason: `Office in "${job.location ?? job.locationRestrictions.join("; ")}" — not remote, but fine at ${job.company}`,
    };
  }
  return scored;
}

function scoreBySource(job: Job): Eligibility {
  switch (job.source) {
    case "nofluffjobs":
    case "justjoin":
      return scorePolishBoard(job);
    case "watchlist":
      return scoreWatchlist(job);
    case "workable":
      return scoreWorkable(job);
    case "hackernews":
      return scoreHackerNews(job);
    case "jobicy":
      return scoreJobicy(job);
    case "dou":
      return scoreDou(job);
    case "himalayas":
      return scoreHimalayas(job);
    case "remoteok":
      return scoreRemoteOk(job);
    case "arbeitnow":
      return scoreArbeitnow(job);
    case "indeed":
    case "linkedin":
    case "glassdoor":
    case "google":
    case "zip_recruiter":
      return scoreScraped(job);
    default:
      return { eligible: true, level: "medium", reason: "Unknown source — not assessed" };
  }
}

/** high first, then medium, then low. */
export function levelRank(level: Level): number {
  return level === "high" ? 0 : level === "medium" ? 1 : 2;
}

/* ------------------------------------------------------------------ */
/* Sanity check — `npm run sanity`                                     */
/* ------------------------------------------------------------------ */

function stub(partial: Partial<Job> & Pick<Job, "source">): Job {
  return {
    externalId: "stub",
    title: "Senior Fullstack Engineer",
    company: "ACME",
    url: "https://example.com/job",
    location: null,
    remote: true,
    salary: null,
    salaryMin: null,
    salaryMax: null,
    tags: [],
    postedAt: null,
    locationRestrictions: [],
    ...partial,
  };
}

function runSanityChecks(): void {
  const cases: Array<{ label: string; job: Job; expect: Level }> = [
    {
      label: "himalayas, no restrictions -> high",
      job: stub({ source: "himalayas", locationRestrictions: [] }),
      expect: "high",
    },
    {
      label: "himalayas, worldwide but only American time zones -> medium",
      job: stub({ source: "himalayas", locationRestrictions: [], tags: ["React", "-8", "-7", "-6", "-5"] }),
      expect: "medium",
    },
    {
      label: "himalayas, worldwide with European time zones -> high",
      job: stub({ source: "himalayas", locationRestrictions: [], tags: ["React", "0", "1", "2"] }),
      expect: "high",
    },
    {
      label: "himalayas, allowlist containing Poland -> high",
      job: stub({ source: "himalayas", locationRestrictions: ["Germany", "Poland", "Spain"] }),
      expect: "high",
    },
    {
      label: "himalayas, US + Canada only -> low",
      job: stub({ source: "himalayas", locationRestrictions: ["United States", "Canada"] }),
      expect: "low",
    },
    {
      label: "remoteok, 'Worldwide' -> high",
      job: stub({ source: "remoteok", location: "Worldwide" }),
      expect: "high",
    },
    {
      label: "remoteok, empty location -> medium",
      job: stub({ source: "remoteok", location: "" }),
      expect: "medium",
    },
    {
      label: "remoteok, 'United States' -> low",
      job: stub({ source: "remoteok", location: "United States" }),
      expect: "low",
    },
    {
      label: "arbeitnow, remote -> high",
      job: stub({ source: "arbeitnow", remote: true, location: "Berlin" }),
      expect: "high",
    },
    {
      label: "arbeitnow, onsite Warsaw -> medium",
      job: stub({ source: "arbeitnow", remote: false, location: "Warsaw, Poland" }),
      expect: "medium",
    },
    {
      label: "arbeitnow, onsite Berlin -> low",
      job: stub({ source: "arbeitnow", remote: false, location: "Berlin" }),
      expect: "low",
    },
    // Regression guards for the word-boundary matcher:
    {
      label: "word boundary: 'Deutschland' must NOT match token 'eu' -> low",
      job: stub({ source: "himalayas", locationRestrictions: ["Deutschland"] }),
      expect: "low",
    },
    {
      label: "word boundary: 'EU only' does match -> high",
      job: stub({ source: "remoteok", location: "EU only" }),
      expect: "high",
    },
    {
      label: "word boundary: 'Naples' must NOT match token 'pl' -> medium",
      job: stub({ source: "remoteok", location: "Naples" }),
      expect: "medium",
    },
    // Scraped sources (JobSpy): location text is the only signal.
    {
      label: "indeed, remote 'zdalnie, PL' -> high",
      job: stub({ source: "indeed", remote: true, location: "zdalnie, PL" }),
      expect: "high",
    },
    {
      label: "indeed, remote flag but the text asks for office days -> medium",
      job: stub({
        source: "indeed",
        remote: true,
        location: "zdalnie, PL",
        description: "Please note, the position requires hybrid (3 days office) work in Krakow.",
      }),
      expect: "medium",
    },
    {
      label: "indeed, 'hybrid or 100% remote, your choice' stays high",
      job: stub({
        source: "indeed",
        remote: true,
        location: "zdalnie, PL",
        description: "Możliwość pracy w **trybie hybrydowym** (3 dni z biura) lub **100% zdalnie.**",
      }),
      expect: "high",
    },
    {
      label: "watchlist, company board lists Poland -> high",
      job: stub({ source: "watchlist", remote: false, locationRestrictions: ["Poland"] }),
      expect: "high",
    },
    {
      label: "watchlist, bare 'Remote, Global' -> medium",
      job: stub({ source: "watchlist", remote: true, locationRestrictions: ["Remote, Global"] }),
      expect: "medium",
    },
    {
      label: "watchlist, remote but 'Málaga, Spain' -> low",
      job: stub({ source: "watchlist", remote: true, locationRestrictions: ["Málaga, Spain"] }),
      expect: "low",
    },
    {
      label: "watchlist, remote 'North America' -> low",
      job: stub({ source: "watchlist", remote: true, locationRestrictions: ["North America"] }),
      expect: "low",
    },
    {
      label: "workable, remote, listed in Poland -> high",
      job: stub({ source: "workable", remote: true, workMode: "remote", location: "Warsaw, Poland", locationRestrictions: ["Poland"] }),
      expect: "high",
    },
    {
      label: "workable, remote, listed in Germany -> low",
      job: stub({ source: "workable", remote: true, workMode: "remote", location: "Berlin, Germany", locationRestrictions: ["Germany"] }),
      expect: "low",
    },
    {
      label: "hackernews, 'REMOTE (CET)' -> high",
      job: stub({ source: "hackernews", remote: true, locationRestrictions: ["eventfirst | Senior Full-Stack Engineer | Berlin, Germany | REMOTE (CET) | Full-time"] }),
      expect: "high",
    },
    {
      label: "hackernews, 'Remote (US only)' -> low",
      job: stub({ source: "hackernews", remote: true, locationRestrictions: ["Octane | Senior Software Engineer | REMOTE (US only) or NYC/Dallas"] }),
      expect: "low",
    },
    {
      label: "hackernews, 'Remote (Germany)' -> low",
      job: stub({ source: "hackernews", remote: true, locationRestrictions: ["Avision GmbH | Full Stack Developer | Remote (Germany)"] }),
      expect: "low",
    },
    {
      label: "hackernews, bare 'REMOTE' -> medium",
      job: stub({ source: "hackernews", remote: true, locationRestrictions: ["Trackerbot | Full-Stack Developer (Node.js) | REMOTE"] }),
      expect: "medium",
    },
    {
      label: "hackernews, onsite in San Francisco -> low",
      job: stub({ source: "hackernews", remote: false, locationRestrictions: ["VOYGR | Founding Product Engineer | San Francisco | ONSITE"] }),
      expect: "low",
    },
    {
      label: "jobicy, open to Europe -> high",
      job: stub({ source: "jobicy", remote: true, locationRestrictions: ["Europe"] }),
      expect: "high",
    },
    {
      label: "jobicy, Canada, Poland, UK, USA -> high",
      job: stub({ source: "jobicy", remote: true, locationRestrictions: ["Canada", "Poland", "UK", "USA"] }),
      expect: "high",
    },
    {
      label: "jobicy, UK only -> low",
      job: stub({ source: "jobicy", remote: true, locationRestrictions: ["UK"] }),
      expect: "low",
    },
    {
      label: "dou, remote from abroad -> high",
      job: stub({ source: "dou", remote: true, locationRestrictions: ["Київ", "за кордоном"] }),
      expect: "high",
    },
    {
      label: "dou, remote, no country -> medium",
      job: stub({ source: "dou", remote: true, locationRestrictions: ["Київ"] }),
      expect: "medium",
    },
    {
      label: "dou, office in Lviv -> low",
      job: stub({ source: "dou", remote: false, locationRestrictions: ["Львів"] }),
      expect: "low",
    },
    {
      label: "nofluffjobs, remote -> high",
      job: stub({ source: "nofluffjobs", remote: true, workMode: "remote", location: "Remote, PL" }),
      expect: "high",
    },
    {
      label: "justjoin, hybrid in Warsaw -> medium",
      job: stub({ source: "justjoin", remote: false, workMode: "hybrid", location: "Warszawa, PL" }),
      expect: "medium",
    },
    {
      label: "indeed, 'zdalnie, PL' with missing remote flag -> high",
      job: stub({ source: "indeed", remote: false, location: "zdalnie, PL" }),
      expect: "high",
    },
    {
      label: "indeed, onsite 'Warszawa, MZ, PL' -> medium (you live there, not remote)",
      job: stub({ source: "indeed", remote: false, location: "Warszawa, MZ, PL" }),
      expect: "medium",
    },
    {
      label: "indeed, Google onsite 'Warszawa, MZ, PL' -> high (a giant's office in Warsaw is fine)",
      job: stub({ source: "indeed", company: "Google", remote: false, location: "Warszawa, MZ, PL" }),
      expect: "high",
    },
    {
      label: "linkedin, Amazon Web Services 'remote' with office days in Warsaw -> high",
      job: stub({
        source: "linkedin",
        company: "Amazon Web Services",
        remote: true,
        location: "Warsaw, Mazowieckie, Poland",
        description: "This is a hybrid role: 3 days a week in our Warsaw office.",
      }),
      expect: "high",
    },
    {
      label: "justjoin, Microsoft hybrid in Warsaw -> high",
      job: stub({ source: "justjoin", company: "Microsoft", remote: false, workMode: "hybrid", location: "Warszawa, PL" }),
      expect: "high",
    },
    {
      label: "indeed, Google onsite 'Kraków, ML, PL' -> medium (no relocation, even for a giant)",
      job: stub({ source: "indeed", company: "Google", remote: false, location: "Kraków, ML, PL" }),
      expect: "medium",
    },
    {
      label: "indeed, 'Metaverse Labs' onsite Warsaw -> medium (Meta is a whole word)",
      job: stub({ source: "indeed", company: "Metaverse Labs", remote: false, location: "Warszawa, MZ, PL" }),
      expect: "medium",
    },
    {
      label: "linkedin, the card says only 'Poland' -> high (remote search, the whole country)",
      job: stub({ source: "linkedin", remote: false, location: "Poland" }),
      expect: "high",
    },
    {
      label: "linkedin, no place on the card -> high (JobSpy dropped 'Poland'; the search is Poland)",
      job: stub({ source: "linkedin", remote: false, location: null }),
      expect: "high",
    },
    {
      label: "linkedin, 'Wroclaw Metropolitan Area' -> medium (a Polish city, not the whole country)",
      job: stub({ source: "linkedin", remote: false, location: "Wroclaw Metropolitan Area" }),
      expect: "medium",
    },
    {
      label: "watchlist, the company board says 'Warsaw' -> high",
      job: stub({ source: "watchlist", remote: false, locationRestrictions: ["Warsaw"] }),
      expect: "high",
    },
    {
      label: "linkedin, the card says only 'United States' -> low",
      job: stub({ source: "linkedin", remote: false, location: "United States" }),
      expect: "low",
    },
    {
      label: "linkedin, onsite 'Cracow, Małopolskie, Poland' -> medium",
      job: stub({ source: "linkedin", remote: false, location: "Cracow, Małopolskie, Poland" }),
      expect: "medium",
    },
    {
      label: "indeed, onsite 'Berlin, Germany' -> low (permit is Poland-only)",
      job: stub({ source: "indeed", remote: false, location: "Berlin, Germany" }),
      expect: "low",
    },
    {
      label: "linkedin, onsite 'Austin, TX' -> low",
      job: stub({ source: "linkedin", remote: false, location: "Austin, TX" }),
      expect: "low",
    },
    {
      label: "indeed, no location stated -> medium",
      job: stub({ source: "indeed", remote: false, location: "" }),
      expect: "medium",
    },
    {
      label: "indeed, REMOTE but listed 'Berlin, BE, DE' -> medium (may require DE residency)",
      job: stub({ source: "indeed", remote: true, location: "Berlin, BE, DE" }),
      expect: "medium",
    },
    {
      label: "linkedin, remote 'Amsterdam, Netherlands' -> medium, not high",
      job: stub({ source: "linkedin", remote: true, location: "Amsterdam, North Holland, Netherlands" }),
      expect: "medium",
    },
  ];

  let failed = 0;
  for (const { label, job, expect } of cases) {
    const got = scoreEligibility(job);
    const ok = got.level === expect;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
    console.log(`      -> ${got.level}: ${got.reason}`);
  }

  /**
   * Ranking checks. These exist because a live "React" search once returned
   * "Senior .NET Engineer (Full-Stack, Front-End, Cloud & AI)" as the TOP hit:
   * it mentioned React in the body, matched on "Full-Stack", and recency
   * outranked relevance. Tier 3 means "sinks to the bottom of the list".
   */
  const fitCases: Array<{ title: string; expect: number }> = [
    // wrong stack -> tier 3, however senior or well-worded the title
    { title: "Senior .NET Engineer (Full-Stack, Front-End, Cloud & AI)", expect: 3 },
    { title: "Senior C# Azure Engineer", expect: 3 },
    { title: "Senior Java Developer", expect: 3 },
    { title: "Full-stack Technical Lead (Java+React)", expect: 3 },
    { title: "Senior PHP Engineer", expect: 3 },
    { title: "Senior FrontEnd Developer (VueJS)", expect: 3 },
    { title: "Senior Mobile Application Engineer", expect: 3 },
    { title: "Power Platform Developer", expect: 3 },
    { title: "Senior Full Stack Engineer - Python, AWS with React", expect: 3 },
    // not engineering at all
    { title: "Senior Talent Acquisition Manager", expect: 3 },
    { title: "Senior UI & UX / Graphic Designer", expect: 3 },
    // junior openings are as poor a fit for a senior as a foreign stack
    { title: "Internship - Full-stack Software Engineer", expect: 3 },
    { title: "Junior React Developer", expect: 3 },
    { title: "Praktykant Frontend Developer", expect: 3 },
    // real matches
    { title: "Senior React Developer (Next.js, TypeScript)", expect: 0 },
    { title: "Senior TypeScript Engineer (NestJS, GraphQL)", expect: 0 },
    { title: "Senior Full-stack Developer", expect: 1 },
    // Frontend is a primary target, so a plain frontend title reaches the top
    // tier on its own — fullstack does not.
    { title: "Senior Frontend Developer", expect: 0 },
    // React Native is mobile work, not the web frontend target.
    { title: "Senior React Native Developer", expect: 3 },
    // nothing recognised either way
    { title: "Senior Software Engineer, Growth", expect: 2 },
    // Frontend is the target, AI a bonus: an AI title with no frontend in it
    // is capped at a partial match (profile.ts aiOnlyTitle); AI on a frontend
    // title stays at the top. Backend-titled and ML roles are out.
    { title: "Senior AI Engineer (LLM, RAG)", expect: 1 },
    { title: "LLM Engineer - Prompt Pipelines", expect: 1 },
    { title: "Senior Frontend Engineer (AI Applications)", expect: 0 },
    { title: "Senior UI Engineer, Design System", expect: 0 },
    { title: "Senior Backend Engineer (NestJS)", expect: 3 },
    { title: "Senior ML Engineer (PyTorch)", expect: 3 },
    { title: "Machine Learning Engineer - Computer Vision", expect: 3 },
    { title: "Frontend Developer - Angular/TypeScript", expect: 3 },
  ];

  // A giant in Warsaw reaches Claude whatever its stack score; its title gate still stands.
  const giant = (title: string, description: string) =>
    stub({ source: "indeed", company: "Google", title, location: "Warszawa, MZ, PL", remote: false, description });
  const giantCases: Array<{ job: Job; expect: number; label: string }> = [
    { job: giant("Software Engineer III, Front End, Google Cloud", "Experience with one or more programming languages: Java, C++, Python, JavaScript or Go."), expect: 1, label: "Google Warsaw, front end, languages list" },
    { job: giant("Senior Software Engineer, Android", "Kotlin and Java."), expect: 3, label: "Google Warsaw, Android title" },
  ];
  for (const { job, expect, label } of giantCases) {
    const tier = fitTier(job);
    const ok = tier === expect;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  giant fit tier ${expect}: ${label}`);
    if (!ok) console.log(`      -> got tier ${tier} (score ${stackFit(job)})`);
  }

  for (const { title, expect } of fitCases) {
    const job = stub({ source: "indeed", title, remote: true, location: "zdalnie, PL" });
    const tier = fitTier(job);
    const ok = tier === expect;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  fit tier ${expect}: ${title}`);
    if (!ok) console.log(`      -> got tier ${tier} (score ${stackFit(job)})`);
  }

  const descriptionCases: Array<{ title: string; description: string; expect: number }> = [
    {
      title: "Senior Software Engineer",
      description: "Build a React frontend with TypeScript and Next.js.",
      expect: 0,
    },
    {
      title: "Senior Frontend Developer",
      description: "Java and Spring Boot are required for day-to-day development.",
      expect: 3,
    },
    // The title is a gate: a body full of the right stack must not lift a
    // junior or wrong-stack title into the feed (both used to reach tier 0/1).
    {
      title: "Junior Frontend Developer (React.js)",
      description: "React, TypeScript, Next.js, Redux, Tailwind, Storybook and accessibility.",
      expect: 3,
    },
    {
      title: "Angular Software Developer",
      description: "Frontend work with TypeScript; some React and Next.js on newer modules.",
      expect: 3,
    },
    // "intern" is a word, not a substring: Internal Tools is a senior role.
    {
      title: "Senior Frontend Engineer, Internal Tools",
      description: "React and TypeScript.",
      expect: 0,
    },
    // A mild penalty term next to a target term does not gate the title.
    {
      title: "Fullstack Developer (Frontend/Backend)",
      description: "React, TypeScript and Node.js.",
      expect: 0,
    },
  ];
  for (const { title, description, expect } of descriptionCases) {
    const job = stub({ source: "indeed", title, description });
    const tier = fitTier(job);
    const ok = tier === expect;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  description fit tier ${expect}: ${title}`);
    if (!ok) console.log(`      -> got tier ${tier} (score ${stackFit(job)})`);
  }

  const total = cases.length + fitCases.length + descriptionCases.length + 2;
  console.log(`\n${total - failed}/${total} checks passed.`);
  if (failed > 0) process.exitCode = 1;
}

// Runs only when this file is executed directly, not when imported.
const invokedPath = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (invokedPath.endsWith("eligibility.ts")) {
  runSanityChecks();
}
