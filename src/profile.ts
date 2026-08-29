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
 * TARGET: frontend roles. AI/LLM is a bonus on top, not a target of its own.
 *   Frontend terms carry the highest weights; fullstack counts less; backend is
 *   a positive signal *inside* a posting but a penalty in a title. AI terms are
 *   deliberately small — LLM work makes a frontend role more attractive, but
 *   "AI Engineer" is not the job being searched for. ML/data-science roles are
 *   penalised outright — I integrate LLMs into products, I do not train models.
 *   To shift the emphasis, change the weights below; nothing else needs to know.
 */

import type { Job, SourceName } from "./sources.ts";

/**
 * The searches the "Refresh" button runs. Several complementary queries rather
 * than one, because boards match keywords rather than meaning: the same job is
 * posted as "Frontend Developer" by one company and "Web Engineer" by the next.
 *
 * Results are merged and deduped, so overlap between queries is free. Order is
 * NOT a ranking signal — every query is fetched in parallel and the merged list
 * is sorted by professional fit, then eligibility and recency (see pipeline.ts).
 * Order only decides which copy of a duplicate survives dedupe. What actually
 * keeps fullstack below frontend is its weight in STACK_WEIGHTS (2 vs 4).
 *
 * Each line earns its place — measured over indeed + himalayas, counting only
 * jobs no earlier query had already found:
 *
 *   frontend developer     +25    web developer         +12
 *   frontend engineer      +23    web engineer          +21
 *   react developer        +20    next.js                +4
 *   react engineer         +15    fullstack typescript   +4
 *   javascript developer   +16    -------------------------
 *   javascript engineer    +17    157 unique good-fit jobs
 *
 * Cost is linear in the number of queries, and mostly invisible (they run
 * concurrently) — until the "+ LinkedIn" tick-box is on, where each query is
 * its own slow scrape. Trim this list first if that pass gets too slow.
 */
export const TARGET_QUERIES: string[] = [
  // frontend — the whole point of the feed. Both "developer" and "engineer":
  // they are the same job and the boards treat them as different keywords.
  "frontend developer",
  "frontend engineer",
  "react developer",
  "react engineer",
  "javascript developer",
  "javascript engineer",
  "web developer",
  "web engineer",
  // A framework name rather than a job title, so it mostly re-finds what the
  // react queries already have — 4 jobs beyond them. Cheap enough to keep.
  "next.js",
  // Fullstack last, and it shows: also only 4 the frontend queries missed.
  // Kept because frontend-heavy roles do get titled "fullstack" and it is real
  // CV experience — it just carries half the weight of frontend when scoring.
  "fullstack typescript",
];

/**
 * JOBHUNT_SOURCES overrides the board list for one run, e.g.
 * `JOBHUNT_SOURCES=indeed,himalayas npm run dashboard` for a fast pass without
 * editing this file. Unknown names are ignored; an empty result keeps the
 * defaults, so a typo degrades to normal behaviour rather than to no search.
 * tests/ui.mjs uses it to keep the suite off the slow boards.
 */
function resolveSources(defaults: SourceName[]): SourceName[] {
  const raw = (process.env["JOBHUNT_SOURCES"] ?? "").split(",").map((name) => name.trim());
  const picked = defaults.filter((source) => raw.includes(source));
  return picked.length > 0 ? picked : defaults;
}

/** Fixed search settings — the things that do not change between runs. */
export const SEARCH_DEFAULTS = {
  /** Where scraped boards look. Indeed is country-scoped, so keep it real. */
  location: "Poland",
  /** Remote is the goal; onsite-in-Poland still surfaces at `medium`. */
  remoteOnly: true,
  /**
   * The widest window the UI offers: one month. Older postings are usually
   * filled. The date control narrows within this; it can never widen past it.
   */
  hoursOld: 720,
  /**
   * The boards the dashboard queries, and the source filter it offers: the
   * Search tab shows one toggle per entry and can only narrow this list, never
   * add to it. Indeed for volume, LinkedIn for the postings Indeed misses,
   * Himalayas for salaries and worldwide-remote.
   *
   * LinkedIn is the slow one — it is most of the wall clock on a full pass, so
   * switching it off in the toolbar is how you get a fast search back.
   *
   * glassdoor and zip_recruiter are absent and cannot be added — measured
   * against the live boards from Poland:
   *   glassdoor      JobSpy refuses outright: "Glassdoor is not available for
   *                  POLAND". It cannot be scoped to Poland at all.
   *   zip_recruiter  returns zero rows, and zero for a US location too, so it
   *                  is not a geography problem — the scraper is simply dead.
   */
  sources: resolveSources(["indeed", "linkedin", "himalayas"]),
  /**
   * Boards the MCP `find_jobs` tool leaves out of a bare profile search.
   *
   * Not a preference — a hard constraint. The MCP protocol times a request out
   * after 60s, and LinkedIn alone takes a pass from ~3s to ~80s, so a bare
   * `find_jobs` including it fails outright rather than answering slowly. The
   * dashboard is a different story: it shows progress, and its source pills let
   * you drop the board in one click, so there it stays on.
   */
  slowSources: ["linkedin"] as SourceName[],
  /**
   * Keep only clear and partial matches. Neutral tier 2 postings have no target
   * signal in either title or body; tier 3 is wrong stack, junior, or
   * non-engineering. Broad board queries return many of both.
   */
  maxFitTier: 1,
  /**
   * How many ranked matches the search returns. This is a budget for the page
   * to draw from, not a page size — the Search tab renders a screenful at a
   * time and extends as you scroll.
   *
   * It used to be 40, and that was the wrong number: a pass keeps ~290 good
   * matches after ranking, then the page hides some of them again (already in
   * the funnel, dismissed, outside the date window). Cutting to 40 first meant
   * fetching eight hundred postings to show a dozen. Raising it costs nothing —
   * the boards cap what they return long before this does.
   */
  limit: 200,
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

  // ---- AI / LLM: a bonus, not a target ----
  // These used to be weighted as high as frontend, and the feed filled up with
  // AI roles. An LLM product is a nicer frontend job, so it still scores — just
  // never enough to outrank an actual frontend posting.
  ["ai", 1],
  ["ai engineer", 1],
  ["llm", 2],
  ["genai", 1],
  ["openai", 1],
  ["anthropic", 1],
  ["claude", 1],
  ["prompt", 1],
  ["agentic", 1],
  ["rag", 1],
  ["mcp", 1],
  ["chatbot", 1],

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
  ["angularjs", 6],
  ["vue", 6],
  ["vue.js", 6],
  ["vuejs", 6],
  ["svelte", 6],
  // Mobile.
  ["android", 6],
  ["ios", 6],
  ["swift", 6],
  ["flutter", 6],
  ["unity", 6],
  ["unreal", 6],
  ["embedded", 6],
  ["mobile developer", 8],
  ["mobile engineer", 8],
  ["mobile application engineer", 8],
  ["power platform", 8],
  // React Native is mobile work, not the web frontend target. The title-level
  // penalty must remain strong even when a long description mentions React,
  // TypeScript and other transferable skills.
  ["react native", 6],
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
  // JobSpy gives us the full Indeed description. It can rescue a generic title
  // whose actual work is React, or reject one whose body requires Java/Vue.
  // LinkedIn descriptions remain optional because fetching each one is slow.
  const rest = [job.tags.join(" "), job.description ?? ""].join(" ").toLowerCase();

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

export type MatchLevel = "high" | "medium" | "low";

/** User-facing professional match, separate from work eligibility. */
export function matchLevel(job: Job): MatchLevel {
  const tier = fitTier(job);
  return tier === 0 ? "high" : tier === 1 ? "medium" : "low";
}

/** Fine-grained tiebreak inside a tier. */
export function relevanceBoost(job: Job): number {
  return stackFit(job);
}
