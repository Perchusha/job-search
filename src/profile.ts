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
 *
 * TARGET: frontend and AI/LLM roles.
 *   Frontend and AI terms carry the highest weights; fullstack counts less;
 *   backend is a positive signal *inside* a posting but a penalty in a title.
 *   ML/data-science roles are penalised — I integrate LLMs into products, I do
 *   not train models. To shift the emphasis, change the weights below; nothing
 *   else in the codebase needs to know.
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
  // frontend
  "frontend developer",
  "react developer",
  "next.js",
  // AI / LLM product work (integration, not ML research)
  "ai engineer",
  "llm engineer",
  // Fullstack stays: plenty of frontend-heavy roles are titled "fullstack",
  // and it is real CV experience. It just carries less weight than frontend
  // in the scoring below.
  "fullstack typescript",
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
  // ---- frontend: the primary target, weighted highest ----
  ["frontend", 4],
  ["front-end", 4],
  ["front end", 4],
  ["react", 4],
  ["next.js", 4],
  ["nextjs", 4],
  ["typescript", 3],
  ["javascript", 2],
  ["ui engineer", 3],
  ["web developer", 2],
  // frontend craft
  ["redux", 2],
  ["zustand", 2],
  ["tailwind", 2],
  ["mui", 1],
  ["storybook", 2],
  ["vite", 1],
  ["ssr", 2],
  ["accessibility", 2],
  ["design system", 2],
  ["performance optimization", 2],
  ["responsive", 1],

  // ---- AI / LLM: the other primary target ----
  ["ai", 3],
  ["ai engineer", 4],
  ["llm", 4],
  ["genai", 3],
  ["openai", 3],
  ["anthropic", 3],
  ["claude", 3],
  ["prompt", 3],
  ["agentic", 3],
  ["rag", 2],
  ["mcp", 2],
  ["chatbot", 2],

  // ---- fullstack: real experience, deliberately lighter than frontend ----
  ["fullstack", 2],
  ["full-stack", 2],
  ["full stack", 2],
  ["electron", 2],

  // ---- backend I can do, but it is not the target: low weight ----
  ["node", 1],
  ["node.js", 1],
  ["nestjs", 1],
  ["nest.js", 1],
  ["graphql", 2],
  ["rest api", 1],
  ["websocket", 1],
  ["postgres", 1],
  ["supabase", 1],
  ["microservices", 1],

  // ---- practice / seniority signals ----
  ["docker", 1],
  ["ci/cd", 1],
  ["github actions", 1],
  ["vercel", 1],
  ["stripe", 1],
  ["system design", 1],
  ["tech lead", 2],

  // current job's stack — real experience, not a target role on its own
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
  // Hard no: a different language or platform entirely.
  [".net", 10],
  ["c#", 10],
  ["asp.net", 10],
  ["java", 10],
  ["c++", 10],
  ["salesforce", 10],
  ["sap", 10],
  ["abap", 10],
  ["sharepoint", 10],
  ["netsuite", 10],
  // Other backend languages.
  ["python", 6],
  ["django", 6],
  ["ruby", 6],
  ["rails", 6],
  ["golang", 6],
  ["rust", 6],
  ["kotlin", 6],
  ["scala", 6],
  ["spring boot", 8],
  ["laravel", 6],
  ["wordpress", 6],
  ["drupal", 6],
  ["magento", 6],
  // `php` stays mild: Symfony/Twig is my current day job, so PHP is not
  // foreign — but "Senior PHP Engineer" is still not the role I want.
  ["php", 3],
  // Other frontend frameworks. I have touched them (the DHTMLX widget library
  // had to work everywhere), but an Angular or Vue role is not a React role.
  ["angular", 6],
  ["vue", 6],
  ["svelte", 6],
  // Mobile.
  ["android", 6],
  ["ios", 6],
  ["swift", 6],
  ["flutter", 6],
  ["unity", 6],
  ["unreal", 6],
  ["embedded", 6],
  // React Native is not on the CV: React knowledge transfers, but mobile is a
  // different job. Mild on purpose — it lands near neutral, not banned.
  ["react native", 2],
  /**
   * Backend-only roles. I can do backend (Node, NestJS, Postgres) and it stays
   * a positive signal inside a frontend or fullstack posting — but the target
   * is frontend and AI, so a role whose TITLE is "Backend Developer" is off
   * target. Mild, and title-weighted: a fullstack posting mentioning backend
   * work in its tags is unaffected.
   */
  ["backend", 4],
  ["back-end", 4],
  ["back end", 4],
  /**
   * Adjacent to AI but a different profession: I integrate LLMs into products,
   * I do not train models. "AI Engineer" is a match; "ML Engineer" is not.
   */
  ["machine learning", 6],
  ["ml engineer", 8],
  ["deep learning", 6],
  ["computer vision", 5],
  ["mlops", 6],
  // Adjacent engineering roles, not mine.
  ["qa engineer", 6],
  ["tester", 6],
  ["devops engineer", 4],
  ["data engineer", 6],
  ["data scientist", 6],
  // Not engineering at all — these really do come back from a "react" search.
  ["recruiter", 8],
  ["talent acquisition", 8],
  ["accountant", 8],
  ["sales", 8],
  ["marketing", 8],
  ["user acquisition", 8],
  ["designer", 8],
  ["product manager", 8],
  ["project manager", 8],
  ["scrum master", 8],
  ["business analyst", 8],
  ["account manager", 8],
  ["customer success", 8],
  ["support specialist", 8],
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
