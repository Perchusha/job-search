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

/** Score one job for a Poland-based applicant. */
export function scoreEligibility(job: Job): Eligibility {
  switch (job.source) {
    case "himalayas":
      return scoreHimalayas(job);
    case "remoteok":
      return scoreRemoteOk(job);
    case "arbeitnow":
      return scoreArbeitnow(job);
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
  ];

  let failed = 0;
  for (const { label, job, expect } of cases) {
    const got = scoreEligibility(job);
    const ok = got.level === expect;
    if (!ok) failed++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
    console.log(`      -> ${got.level}: ${got.reason}`);
  }

  console.log(`\n${cases.length - failed}/${cases.length} checks passed.`);
  if (failed > 0) process.exitCode = 1;
}

// Runs only when this file is executed directly, not when imported.
const invokedPath = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (invokedPath.endsWith("eligibility.ts")) {
  runSanityChecks();
}
