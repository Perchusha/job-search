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

import { fitTier, stackFit } from "./profile.ts";
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

function firstFriendly(text: string): string | null {
  for (const token of FRIENDLY_TOKENS) {
    if (matchToken(text, token)) return token;
  }
  return null;
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
function scoreScraped(job: Job): Eligibility {
  const location = (job.location ?? "").trim();
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

/** Score one job for a Poland-based applicant. */
export function scoreEligibility(job: Job): Eligibility {
  switch (job.source) {
    case "nofluffjobs":
    case "justjoin":
      return scorePolishBoard(job);
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
    // Frontend + AI emphasis: both targets reach tier 0, backend-titled and
    // ML roles do not. Changing the emphasis means changing profile.ts.
    { title: "Senior AI Engineer (LLM, RAG)", expect: 0 },
    { title: "LLM Engineer - Prompt Pipelines", expect: 0 },
    { title: "Senior UI Engineer, Design System", expect: 0 },
    { title: "Senior Backend Engineer (NestJS)", expect: 3 },
    { title: "Senior ML Engineer (PyTorch)", expect: 3 },
    { title: "Machine Learning Engineer - Computer Vision", expect: 3 },
    { title: "Frontend Developer - Angular/TypeScript", expect: 3 },
  ];

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

  const total = cases.length + fitCases.length + descriptionCases.length;
  console.log(`\n${total - failed}/${total} checks passed.`);
  if (failed > 0) process.exitCode = 1;
}

// Runs only when this file is executed directly, not when imported.
const invokedPath = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (invokedPath.endsWith("eligibility.ts")) {
  runSanityChecks();
}
