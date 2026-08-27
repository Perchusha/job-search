/**
 * profile.ts — who I am and what I am looking for. THE file to edit.
 *
 * Everything personal lives here: the searches to run, where I can work, and
 * how well a posting matches my stack. Nothing else in the codebase encodes any
 * of it, so tuning the job feed means editing this file and nothing else.
 *
 * Built from the CV, not guessed:
 *   Senior Software Engineer, 8+ years, JS/TS. React / Next.js / Node / NestJS,
 *   GraphQL, WebSockets, Electron, Postgres, Supabase, plus real LLM work
 *   (OpenAI, Anthropic, MCP). Based in Warsaw on a Poland residence permit —
 *   not EU-wide work authorisation, which is why onsite roles in other EU
 *   countries score `low`.
 */

import type { Job, SourceName } from "./sources.ts";

/**
 * The searches the "Refresh" button runs. Several complementary queries rather
 * than one, because a single keyword cannot cover both "React" work and
 * "AI/LLM" work, and boards match on keywords rather than meaning.
 *
 * Results are merged and deduped, so overlap between queries is free.
 */
export const TARGET_QUERIES: string[] = [
  "react",
  "typescript",
  "fullstack",
  "node.js",
  "ai engineer",
];

/** Fixed search settings — the things that do not change between runs. */
export const SEARCH_DEFAULTS = {
  /** Where scraped boards look. Indeed is country-scoped, so keep it real. */
  location: "Poland",
  /** Remote is the goal; onsite-in-Poland still surfaces at `medium`. */
  remoteOnly: true,
  /** Ignore anything older than two weeks — stale postings are usually filled. */
  hoursOld: 336,
  /** Indeed for volume, Himalayas for salaries and worldwide-remote. */
  sources: ["indeed", "himalayas"] as SourceName[],
  /**
   * Drop tier 3 outright (wrong stack, junior, non-engineering). In a
   * one-button feed there is no reason to show a .NET role or an internship at
   * all — ranking them last was only useful while a human typed the query.
   */
  maxFitTier: 2,
  /** How many matches to show. */
  limit: 40,
} as const;

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
  // Other frontend frameworks. I have touched them (the DHTMLX widget library
  // had to work everywhere), but an Angular or Vue role is not a React role.
  ["angular", 4],
  ["vue", 3],
  ["svelte", 3],
  ["netsuite", 5],
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
