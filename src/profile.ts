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
  sources: resolveSources(["nofluffjobs", "justjoin", "indeed", "linkedin", "himalayas"]),
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
 * The Polish boards' listing pages to read, one fetch each per pass. They take
 * no free-text query, so what to look for is in the URL: remote, senior, and
 * the stack category. The JavaScript category on justjoin.it also holds
 * Angular and Vue roles; stackFit sorts those out like any other.
 *
 * nofluffjobs pages are cumulative: page=5 returns the first 100 postings.
 * justjoin.it returns 50 per page.
 */
export const POLISH_BOARDS = {
  nofluffjobs: [
    "https://nofluffjobs.com/pl/praca-zdalna/React?criteria=seniority%3Dsenior&page=5",
  ],
  justjoin: [
    "https://justjoin.it/job-offers/remote/javascript?experience-level=senior",
    "https://justjoin.it/job-offers/remote/javascript?experience-level=senior&page=2",
  ],
} as const;

/**
 * What I am asking for, from .claude/skills/job-apply/profile.json: 25–30k PLN
 * net per month on B2B. Postings are compared in that unit — PLN per month,
 * B2B-equivalent — so an hourly rate, a UoP gross figure and a EUR salary can
 * be put side by side.
 *
 * uopToB2b: a UoP gross salary costs roughly 1.2× more on an invoice. The FX
 * rates are deliberately static and rough: they only decide whether a posting
 * sorts above or below the floor, never what a card displays.
 */
export const SALARY = {
  floorB2bPlnMonth: 25_000,
  uopToB2b: 1.2,
  fxToPln: { PLN: 1, EUR: 4.25, USD: 3.9, GBP: 5.0, CHF: 4.5 } as Record<string, number>,
};

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
const TERM_PATTERNS = new Map<string, RegExp>();

function hasTerm(haystack: string, term: string): boolean {
  // Compiled once per term: stackFit runs every term over every posting, and
  // building ~250 RegExps per call was most of a search's CPU time.
  let pattern = TERM_PATTERNS.get(term);
  if (!pattern) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const trailing = /[a-z0-9]$/.test(term) ? "(?![a-z0-9])" : "";
    pattern = new RegExp(`(?<![a-z0-9])${escaped}${trailing}`, "i");
    TERM_PATTERNS.set(term, pattern);
  }
  return pattern.test(haystack);
}

/**
 * Coarse seniority bucket from the title: 0 = senior, 1 = unstated, 2 = junior.
 * Lower sorts first.
 *
 * Scraped boards accept no seniority filter (only Himalayas does), so an
 * "Internship – Full-stack Engineer" would otherwise rank alongside a staff
 * role purely on recency. Includes Polish terms because Indeed PL is bilingual.
 */
const JUNIOR_MARKERS: RegExp[] = [
  // "intern" only as a word: a substring test also matched "Internal",
  // "International" and the Polish "aplikacji internetowych" (web applications).
  /(?<![a-z])intern(s|ship|ships)?(?![a-z])/,
  /(?<![a-z])junior(?![a-z])/,
  /(?<![a-z])jr\./,
  /(?<![a-z])trainee/,
  /(?<![a-z])graduate/,
  /(?<![a-z])entry[- ]level/,
  /(?<![a-z])apprentice/,
  // Polish stems, matched as word starts: praktykant / praktyki, staż /
  // stażysta, młodszy / młodsza.
  /(?<![a-ząćęłńóśźż])praktyk/,
  /(?<![a-ząćęłńóśźż])staż/,
  /(?<![a-ząćęłńóśźż])młodsz/,
];

const SENIOR_MARKERS: RegExp[] = [
  /(?<![a-z])senior(?![a-z])/,
  /(?<![a-z])sr\./,
  /(?<![a-z])lead/,
  // Whole word, so "Staffing" is not a staff role.
  /(?<![a-z])staff(?![a-z])/,
  /(?<![a-z])principal(?![a-z])/,
  /(?<![a-z])architect/,
  /(?<![a-z])head of(?![a-z])/,
  /(?<![a-ząćęłńóśźż])starszy/, // "senior" in Polish
];

export function seniorityBucket(job: Job): number {
  const title = job.title.toLowerCase();
  // Junior wins ties: "Junior/Senior" listings are really junior openings.
  if (JUNIOR_MARKERS.some((marker) => marker.test(title))) return 2;
  if (SENIOR_MARKERS.some((marker) => marker.test(title))) return 0;
  return 1;
}

/**
 * How well a posting matches my stack. Positive = good fit, negative = wrong
 * stack. Title counts double for matches and triple for penalties.
 */
/**
 * Scores are cached per job object. The pipeline asks for the same job's fit
 * from the fit filter, from every comparison inside rankJobs and again in
 * presentJob — about five times per job per search — and the dashboard serves
 * the same cached objects on every request. Jobs are never mutated after they
 * are scored (the pipeline copies them with spread), so the cache cannot go stale.
 */
const FIT_CACHE = new WeakMap<Job, number>();

export function stackFit(job: Job): number {
  const cached = FIT_CACHE.get(job);
  if (cached !== undefined) return cached;
  const score = computeStackFit(job);
  FIT_CACHE.set(job, score);
  return score;
}

function computeStackFit(job: Job): number {
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
/** Title words that keep a role a target even when it also names a mild penalty term. */
const TARGET_TITLE_TERMS = [
  "frontend",
  "front-end",
  "front end",
  "react",
  "next.js",
  "nextjs",
  "fullstack",
  "full-stack",
  "full stack",
  "web",
  "ui engineer",
];

/**
 * True when the TITLE alone rules the role out: a junior opening, or a stack
 * from FOREIGN_STACK. These used to be weights only, and a long description
 * full of React/TypeScript could outscore them — "Junior Frontend Developer
 * (React.js)" reached tier 0 and showed as a HIGH match, "Angular Software
 * Developer" tier 1. A title says what the role is, so it is a gate.
 *
 * Mild penalties (backend, php, devops engineer — under 6) gate only when the
 * title names no target term, so "Fullstack (Frontend/Backend)" still passes.
 */
function titleDisqualifies(job: Job): boolean {
  if (seniorityBucket(job) === 2) return true;
  const title = job.title.toLowerCase();
  const hasTarget = TARGET_TITLE_TERMS.some((term) => hasTerm(title, term));
  return FOREIGN_STACK.some(
    ([term, penalty]) => hasTerm(title, term) && (penalty >= 6 || !hasTarget),
  );
}

const TIER_CACHE = new WeakMap<Job, number>();

export function fitTier(job: Job): number {
  const cached = TIER_CACHE.get(job);
  if (cached !== undefined) return cached;
  const tier = computeFitTier(job);
  TIER_CACHE.set(job, tier);
  return tier;
}

function computeFitTier(job: Job): number {
  if (titleDisqualifies(job)) return 3;
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

/* ------------------------------------------------------------------ */
/* Screening rules                                                     */
/* ------------------------------------------------------------------ */

/**
 * The rules that decide, from the title, that a role is not for me — the same
 * ones the job-screen skill used to apply after the search (scripts/funnel.mjs).
 * The search now applies them itself (src/screening.ts) and puts the hits
 * behind the "скрыто правилами" toggle instead of on screen. funnel.mjs
 * imports them from here, so there is one copy.
 *
 * Matched on whole words; FRONTEND and BACKEND_ONLY are tested against the
 * normalised title, so "Full-Stack" and "Node.js" match.
 */
const T = (pattern: string): RegExp => new RegExp(`(?<![a-z0-9])(?:${pattern})(?![a-z0-9])`, "i");

/** Title-level rejections. Order matters: the first match is the reason. */
export const SCREEN_TITLE_RULES: Array<[reason: string, pattern: RegExp]> = [
  ["junior/intern level", T("junior|intern|internship|trainee|graduate|entry[- ]level|mlodszy|młodszy|staz|staż|praktyk\\w*|apprentice")],
  ["mid-level role, CV is senior", T("middle|mid[- ]?level|regular|engineer (?:2|ii)|developer (?:2|ii)")],
  ["management role, not engineering", T("head of|engineering manager|director|cto|vp|vice president|chief")],
  // AI-training gigs (rating model output, writing prompts for a lab) are not
  // engineering work, whatever the title says about TypeScript.
  ["AI-training gig, not engineering", T("ai training|ai trainer|ai tutor|data annotation|rlhf")],
  ["not an engineering role", T("recruiter|talent|designer|ui/ux design|product manager|project manager|scrum master|business analyst|analyst|account manager|customer success|support|advocate|consultant|informatyk|administrator|technical writer|documentation")],
  ["QA / test role", T("qa|test engineer|tester|sdet|quality|automation test|automation engineer")],
  ["DevOps / infra / security role", T("devops|sre|site reliability|security|cloud architect|platform lead|network|infrastructure|k8s|kubernetes")],
  ["data / ML role", T("data engineer|data scientist|ml engineer|machine learning|deep learning|mlops|data visuali[sz]ation|computer vision")],
  ["AI/ML role, not frontend", T("ai engineer|ai architect|genai|llm engineer|ai infrastructure|ai platform|solutions? architect|agentic solution|ai lead|lead ai|ai engineering")],
  ["mobile role", T("mobile|react native|android|ios|flutter|swift|kotlin|hybrid app")],
  ["wrong stack: .NET / Java", T("\\.net|c#|asp\\.net|java|jvm|spring|kotlin|scala")],
  ["wrong stack: other language", T("python|django|fastapi|ruby|rails|golang|go developer|go engineer|\\(go\\)|rust|elixir|erlang|c\\+\\+|embedded|unity|unreal")],
  ["wrong stack: other frontend framework", T("angular|angularjs|vue|svelte|ui5|sapui5|blazor")],
  ["wrong stack: platform / CMS / ERP", T("shopify|wordpress|drupal|magento|salesforce|sap|abap|sharepoint|power platform|dynamics 365|copilot studio|netsuite|1c|servicenow|low[- ]code|appian|mendix|outsystems|pega|webflow|website editor")],
  ["PHP-first role", T("php|laravel|symfony")],
  ["requires another language", T("german|deutsch|italian|french|spanish|dutch|polish speaker|with (?:german|italian|french|spanish|dutch)|(?:german|italian|french|spanish|dutch)[- ]speaking")],
];

// Tested against the *normalised* title, so "Full-Stack" and "Node.js" match.
export const SCREEN_FRONTEND = T("react|frontend|fullstack|next|web|ui engineer|product engineer");
export const SCREEN_BACKEND_ONLY = T("node|nest|backend|microservices|api developer");

/**
 * Boards and marketplaces that hire through their own account/vetting flow.
 * The skills cannot create accounts, so these go to the "needs you" list.
 */
export const SCREEN_MARKETPLACES = T("lemon\\.io|jobgether|gitstart|proxify|micro1|alignerr|toptal|turing|crossover|upwork|braintrust|andela|arc\\.dev|remotepass");
