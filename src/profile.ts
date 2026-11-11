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

import { preferences, preferencesRevision } from "./preferences.ts";
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
  // Added on 2026-10-30. The day's best finds were "Product Engineer" roles
  // (Revieve, Modash, Checkly, Ashby), a title no query above names; UI
  // engineers are frontend under another name. The AI ones name TypeScript, so
  // the boards return LLM work in my stack rather than Python model work.
  "product engineer",
  "ui engineer",
  "ai engineer typescript",
  "llm typescript",
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
  sources: resolveSources(["nofluffjobs", "justjoin", "watchlist", "workable", "jobicy", "dou", "indeed", "linkedin", "himalayas", "hackernews"]),
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
   * How many cards the Search tab shows, and so how many Claude judges in the
   * background. A budget for the page to draw from, not a page size.
   *
   * It counts only cards that are shown by default (dashboard.ts feedView):
   * rule hits and jobs already applied to or hidden come on top. Counted the
   * other way it lost 23 of 136 cards on 2026-10-24, rule hits taking 87 of
   * the 200 places. It used to be 40, which meant fetching eight hundred
   * postings to show a dozen.
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
 * Workable's search terms (src/boards-intl.ts), each asked for remote roles
 * listed in Poland. Short terms, not TARGET_QUERIES: Workable matches them in
 * the whole posting, and on 2026-10-30 "react" found 25 roles, "typescript" 32,
 * "frontend developer" 19, "web developer" 12 of mostly PHP. Asked one after
 * another once a pass, not ten at once per query.
 */
export const WORKABLE_QUERIES = ["react", "typescript", "javascript", "frontend", "next.js", "fullstack"] as const;

/**
 * jobs.dou.ua's RSS feeds (src/boards-ua.ts), 25 latest postings each: remote
 * by category, "react" in the text, and the Warsaw offices. Node.js is left
 * out: its remote feed is backend roles.
 */
export const DOU_FEEDS = [
  "category=Front End&remote",
  "category=Fullstack&remote",
  "category=JavaScript&remote",
  "search=react&remote",
  "category=Front End&city=Варшава",
  "category=Fullstack&city=Варшава",
] as const;

export type WatchedBoard = {
  vendor: "ashby" | "greenhouse" | "lever" | "workable" | "smartrecruiters" | "recruitee";
  /**
   * The board's slug: jobs.ashbyhq.com/<board>, job-boards.greenhouse.io/<board>,
   * jobs.lever.co/<board>, apply.workable.com/<board>, jobs.smartrecruiters.com/<board>,
   * <board>.recruitee.com.
   */
  board: string;
  company: string;
};

/**
 * Companies whose own job boards are read directly (src/watchlist.ts), once a
 * day. Product companies that hire remote people in Poland, plus the boards
 * behind earlier applications. Add a company by its ATS slug — the part of its
 * jobs URL after the ATS host. A board that 404s shows in the refresh log.
 *
 * Checked live on 2026-10-23; toggl (Ashby), remotecom and clickhouse
 * (Greenhouse) answered 404, and deel and kraken returned empty boards.
 *
 * Added on 2026-10-30 from the ATS links behind my applications and Claude's
 * apply/maybe verdicts (16 boards found among 279 postings, the rest link to
 * job boards), and Ashby itself, found on Jobicy with EU product engineering
 * roles. Hire Hangar and Resourceful Talent Group are staffing firms: most of
 * their roles are elsewhere, and the filter below keeps the ones open to Poland.
 */
export const WATCHLIST: WatchedBoard[] = [
  { vendor: "ashby", board: "linear", company: "Linear" },
  { vendor: "ashby", board: "elevenlabs", company: "ElevenLabs" },
  { vendor: "ashby", board: "posthog", company: "PostHog" },
  { vendor: "ashby", board: "supabase", company: "Supabase" },
  { vendor: "ashby", board: "n8n", company: "n8n" },
  { vendor: "ashby", board: "mimica", company: "Mimica" },
  { vendor: "ashby", board: "whiskeylibrary", company: "Whiskey Library" },
  { vendor: "ashby", board: "leovegasgroup", company: "LeoVegas" },
  { vendor: "greenhouse", board: "elastic", company: "Elastic" },
  { vendor: "greenhouse", board: "gitlab", company: "GitLab" },
  { vendor: "greenhouse", board: "grafanalabs", company: "Grafana Labs" },
  { vendor: "greenhouse", board: "vercel", company: "Vercel" },
  { vendor: "greenhouse", board: "apolloio", company: "Apollo.io" },
  { vendor: "greenhouse", board: "storyblok", company: "Storyblok" },
  { vendor: "lever", board: "swingdev", company: "Swing Development" },
  { vendor: "lever", board: "airslate", company: "airSlate" },
  { vendor: "ashby", board: "ashby", company: "Ashby" },
  { vendor: "ashby", board: "checkly", company: "Checkly" },
  { vendor: "ashby", board: "hirehangar", company: "Hire Hangar" },
  { vendor: "greenhouse", board: "givedirectly", company: "GiveDirectly" },
  { vendor: "workable", board: "modash", company: "Modash" },
  { vendor: "smartrecruiters", board: "InPost", company: "InPost" },
  { vendor: "recruitee", board: "resourcefultalentgroup", company: "Resourceful Talent Group" },
  /*
   * Added on 2026-11-11: 150 product companies tried on the six ATS APIs, 95
   * boards found, these 8 with frontend, fullstack or product roles that pass
   * the filters for Poland. Most boards lost everything to geography (US-only
   * remote, or offices in London, Paris, Stockholm); most Polish product
   * companies have their own careers pages, not one of these ATSes.
   */
  { vendor: "greenhouse", board: "canonical", company: "Canonical" },
  { vendor: "ashby", board: "resend", company: "Resend" },
  { vendor: "ashby", board: "chromatic", company: "Chromatic" },
  { vendor: "lever", board: "metabase", company: "Metabase" },
  { vendor: "ashby", board: "lemlist", company: "lemlist" },
  { vendor: "ashby", board: "attio", company: "Attio" },
  { vendor: "ashby", board: "railway", company: "Railway" },
  { vendor: "ashby", board: "docplanner", company: "Docplanner" },
];

/**
 * What I am asking for, from .claude/skills/job-apply/profile.json: 25–30k PLN
 * net per month on B2B (27.5k target), or 34k PLN gross per month on UoP.
 * Postings are compared in one unit — PLN per month, B2B-equivalent — so an
 * hourly rate, a UoP gross figure and a EUR salary can be put side by side.
 *
 * uopToB2b is my own equivalence, not a market rule of thumb: 34k gross on UoP
 * is worth the same to me as 27.5k on B2B, so a UoP figure counts at ~0.81 of
 * itself — the floor for a UoP posting is ~31k gross. The FX rates are
 * deliberately static and rough: they only decide whether a posting sorts
 * above or below the floor, never what a card displays.
 */
export const SALARY = {
  // From "My terms" (src/preferences.ts): Settings change them, defaults as below.
  get floorB2bPlnMonth(): number {
    return preferences().floorB2bPlnMonth;
  },
  get uopToB2b(): number {
    return preferences().uopEqualsB2b / preferences().uopGross;
  },
  get hoursPerMonth(): number {
    return preferences().hoursPerMonth;
  },
  fxToPln: {
    PLN: 1, EUR: 4.25, USD: 3.9, GBP: 5.0, CHF: 4.5, CAD: 2.85, AUD: 2.55,
    SEK: 0.37, NOK: 0.36, DKK: 0.57, CZK: 0.17, INR: 0.046, BRL: 0.7, PHP: 0.067, UAH: 0.094,
  } as Record<string, number>,
};

/**
 * The one exception to remote-only: a giant worth going to an office for —
 * Google, Apple, Netflix and their peers, subsidiaries included. Their hybrid
 * and onsite roles count as fine, but only in Warsaw: I live there and do not
 * relocate, so "3 days a week in the Kraków office" is still not for me.
 *
 * Whole words against the company name, so "Google Poland" and "Amazon Web
 * Services" count and "Metaverse Labs" does not. src/verdict-criteria.md
 * names the same companies for Claude's verdict — change both.
 */
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let officeCache: { revision: number; companies: RegExp; city: RegExp } | null = null;

function officePatterns(): { companies: RegExp; city: RegExp } {
  if (officeCache && officeCache.revision === preferencesRevision()) return officeCache;
  const p = preferences();
  const words = (list: string[]) => list.map((name) => escapeRe(name.toLowerCase())).join("|") || "(?!)";
  // A city as a stem, so its Polish forms match too: Warszawa, Warszawie, w Warszawy.
  const stems = p.officeCities.map((city) => `${escapeRe(city.toLowerCase().replace(/[aeiouy]$/, ""))}\\w*`).join("|") || "(?!)";
  officeCache = {
    revision: preferencesRevision(),
    companies: new RegExp(`(?<![a-z0-9])(?:${words(p.officeCompanies)})(?![a-z0-9])`, "i"),
    city: new RegExp(`(?<![a-z0-9])(?:${stems})(?![a-z0-9])`, "i"),
  };
  return officeCache;
}

export const OFFICE_OK = {
  /** Whole words against the company name: "Google Poland" counts, "Metaverse Labs" does not. */
  get companies(): RegExp {
    return officePatterns().companies;
  },
  get city(): RegExp {
    return officePatterns().city;
  },
  /**
   * LinkedIn's own search for these offices (src/refresh.ts), once a day
   * beside the remote queries. Those ask for remote roles only, so an office
   * role at Google in Warsaw reached the store by accident: 5 such rows of 723.
   * LinkedIn reads OR in keywords; one such query returned 27 giant postings
   * in Warsaw of its first 30. Rows that are not one of these offices are
   * dropped.
   */
  get linkedin(): { query: string; location: string } {
    const p = preferences();
    const city = p.officeCities.find((name) => /^warsaw$/i.test(name)) ?? p.officeCities[0] ?? "Warsaw";
    return {
      query: `(${p.officeCompanies.join(" OR ")}) engineer`,
      location: /^warsaw$/i.test(city) ? "Warsaw, Mazowieckie, Poland" : `${city}, Poland`,
    };
  },
};

/** A hybrid or onsite role I would take: one of OFFICE_OK's companies, in its city. */
export function officeAcceptable(job: Pick<Job, "company" | "location" | "locationRestrictions">): boolean {
  const places = [job.location ?? "", ...(job.locationRestrictions ?? [])].join("; ");
  return OFFICE_OK.companies.test(job.company) && OFFICE_OK.city.test(places);
}

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

/*
 * Spellings of one stack, penalised once per posting however many of them it
 * writes. Modash's product role wrote "Vue" in one place and "Vue.js" in
 * another and paid -12; a fullstack posting with "backend" and "back-end", -8.
 */
const SAME_STACK: string[][] = [["vue", "vue.js", "vuejs"], ["angular", "angularjs"], ["backend", "back-end", "back end"]];
const FOREIGN_GROUPS: Array<Array<[term: string, penalty: number]>> = (() => {
  const groups = new Map<string, Array<[string, number]>>();
  for (const entry of FOREIGN_STACK) {
    const head = SAME_STACK.find((group) => group.includes(entry[0]))?.[0] ?? entry[0];
    groups.set(head, [...(groups.get(head) ?? []), entry]);
  }
  return [...groups.values()];
})();

/** The non-engineering roles above: in a company's own text they may be its product (stackFit). */
const ROLE_WORDS = new Set(FOREIGN_STACK.slice(FOREIGN_STACK.findIndex(([term]) => term === "recruiter")).map(([term]) => term));

/**
 * Whole-word term test. Terms ending in a symbol (".net", "c#", "c++") get no
 * trailing boundary, because a word boundary never fires after a symbol.
 *
 * A term that is also listed with a dotted ending ("vue" and "vue.js", "node"
 * and "node.js") does not match where that longer spelling is written: one
 * mention is one term. "Vue.js" in a posting used to count as both, -12
 * instead of -6, which cut Modash's and Checkly's product engineer roles.
 */
const TERM_PATTERNS = new Map<string, RegExp>();
const escapeTerm = (term: string) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DOTTED_TERMS = [...STACK_WEIGHTS, ...FOREIGN_STACK].map(([term]) => term).filter((term) => /^[a-z0-9]+\./.test(term));

function hasTerm(haystack: string, term: string): boolean {
  // Compiled once per term: stackFit runs every term over every posting, and
  // building ~250 RegExps per call was most of a search's CPU time.
  let pattern = TERM_PATTERNS.get(term);
  if (!pattern) {
    const escaped = escapeTerm(term);
    const longer = DOTTED_TERMS.filter((other) => other.startsWith(term + ".")).map((other) => escapeTerm(other.slice(term.length)));
    const trailing = /[a-z0-9]$/.test(term)
      ? `(?![a-z0-9]${longer.length ? `|(?:${longer.join("|")})(?![a-z0-9])` : ""})`
      : "";
    pattern = new RegExp(`(?<![a-z0-9])${escaped}${trailing}`, "i");
    TERM_PATTERNS.set(term, pattern);
  }
  return pattern.test(haystack);
}

/**
 * The CV terms (STACK_WEIGHTS) a posting names, in the order it names them —
 * what apply.mjs's cover letter mentions as "the stack you ask for".
 */
export function postingStack(job: Job): string[] {
  const text = [job.title, ...job.tags, job.description ?? ""].join(" ");
  return STACK_WEIGHTS.flatMap(([term, weight]) => {
    if (weight < 2 || !hasTerm(text, term)) return [];
    return [{ term, at: text.search(TERM_PATTERNS.get(term) as RegExp) }];
  })
    .sort((a, b) => a.at - b.at)
    .map(({ term }) => term);
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
  // Google's "Software Engineer, Early Careers, PhD" and "new grad" roles.
  /(?<![a-z])early[- ]careers?(?![a-z])/,
  /(?<![a-z])new[- ]grad/,
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

/** A board's own level field or seniority tag (Himalayas, nofluffjobs, justjoin.it). */
const BOARD_SENIOR = /^(?:senior|lead|staff|principal|expert|manager)\b/i;
const BOARD_LOWER = /^(?:mid(?:-level)?|middle|regular|entry(?:-level)?|junior|intern)\b/i;

/**
 * 0 = senior, 1 = unstated, 1.5 = the board says mid/entry level, 2 = junior
 * by title. The title decides first; a title with no level falls back to the
 * board's own field. On one Himalayas pass 13 of 31 results were tagged
 * Mid-level and ranked as "unstated" next to senior roles. Board tags only
 * demote — the user did apply to two Mid-level-tagged roles — and never gate.
 */
export function seniorityBucket(job: Job): number {
  const title = job.title.toLowerCase();
  // Junior wins ties: "Junior/Senior" listings are really junior openings.
  if (JUNIOR_MARKERS.some((marker) => marker.test(title))) return 2;
  if (SENIOR_MARKERS.some((marker) => marker.test(title))) return 0;
  const levels = [job.seniorityLevel ?? "", ...job.tags].map((tag) => tag.trim());
  if (levels.some((tag) => BOARD_SENIOR.test(tag))) return 0;
  if (levels.some((tag) => BOARD_LOWER.test(tag))) return 1.5;
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
  // A Hacker News post describes the company and every role it hires for, so
  // a stack in its body may be another role's: Revieve's "TypeScript/React up
  // front" sat beside computer vision and scored -1, Modash -8. Only its title
  // counts against it; Claude reads the post.
  const bodyPenalties = job.source !== "hackernews";
  // A company I chose writes about its own product: Ashby sells recruiting
  // software, and "recruiter", "sales", "talent acquisition" in its EU product
  // engineering roles scored -29. On its board a role word in the text is the
  // product, not the job; a foreign stack still counts. Dropping every body
  // penalty there instead kept 97 roles rather than 30, mostly Go and Java.
  const roleWordsCount = job.source !== "watchlist";
  for (const spellings of FOREIGN_GROUPS) {
    const penalty = spellings[0]![1];
    // A foreign stack named in the title is close to disqualifying.
    if (spellings.some(([term]) => hasTerm(title, term))) score -= penalty * 3;
    else if (bodyPenalties && spellings.some(([term]) => (roleWordsCount || !ROLE_WORDS.has(term)) && hasTerm(rest, term))) score -= penalty;
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

/**
 * Why the fit gate leaves a job out (tier 3), for Settings → Rules: a
 * junior title, a foreign stack in the title (the term), or one that
 * outweighs the target stack in the text. null when the gate keeps it.
 */
export function fitGateReason(job: Job): { kind: "junior" | "title-stack" | "text-stack"; term: string | null } | null {
  if (fitTier(job) < 3) return null;
  if (seniorityBucket(job) === 2) return { kind: "junior", term: null };
  const title = job.title.toLowerCase();
  const hasTarget = TARGET_TITLE_TERMS.some((term) => hasTerm(title, term));
  const foreign = FOREIGN_STACK.find(([term, penalty]) => hasTerm(title, term) && (penalty >= 6 || !hasTarget));
  return foreign ? { kind: "title-stack", term: foreign[0] } : { kind: "text-stack", term: null };
}

const TIER_CACHE = new WeakMap<Job, number>();

export function fitTier(job: Job): number {
  const cached = TIER_CACHE.get(job);
  if (cached !== undefined) return cached;
  const tier = computeFitTier(job);
  TIER_CACHE.set(job, tier);
  return tier;
}

const AI_TITLE_TERMS = ["ai", "llm", "genai", "agentic", "prompt", "rag"];

/**
 * An AI role with no frontend/fullstack/web in its title. "AI Engineer is not
 * the job being searched for" (header): such titles are capped at tier 1, a
 * partial match ranked after the frontend roles. Not lower — I did apply to
 * "Technical Lead, Senior AI Engineer" — but they no longer reach the top as
 * "Senior AI Engineer (LLM, RAG)" did with fit +10.
 */
function aiOnlyTitle(job: Job): boolean {
  const title = job.title.toLowerCase();
  return (
    AI_TITLE_TERMS.some((term) => hasTerm(title, term)) &&
    !TARGET_TITLE_TERMS.some((term) => hasTerm(title, term))
  );
}

function computeFitTier(job: Job): number {
  if (titleDisqualifies(job)) return 3;
  // A giant's office in Warsaw (OFFICE_OK) is the one exception to remote-only,
  // and their postings are written to defeat this score: a title that names
  // no stack ("Senior Software Engineer, <product>") and a list of languages
  // in the minimum requirements ("Java, C++, Python or Go"). 10 of the 13
  // Warsaw postings of a month were cut here, before the exception or Claude
  // saw them. The title gate above still stands (junior, Android, backend…).
  if (officeAcceptable(job)) return stackFit(job) >= 6 ? 0 : 1;
  const score = stackFit(job);
  if (score < 0) return 3; // wrong stack — bottom of the list
  if (score >= 6) return aiOnlyTitle(job) ? 1 : 0; // clear match
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
 * behind the "Hidden by rules" toggle instead of on screen. funnel.mjs
 * imports them from here, so there is one copy.
 *
 * Matched on whole words; FRONTEND and BACKEND_ONLY are tested against the
 * normalised title, so "Full-Stack" and "Node.js" match.
 */
const T = (pattern: string): RegExp => new RegExp(`(?<![a-z0-9])(?:${pattern})(?![a-z0-9])`, "i");

/** Title-level rejections. Order matters: the first match is the reason. */
export const SCREEN_TITLE_RULES: Array<[reason: string, pattern: RegExp]> = [
  ["junior/intern level", T("junior|intern|internship|trainee|graduate|new[- ]grad|early[- ]careers?|entry[- ]level|mlodszy|młodszy|staz|staż|praktyk\\w*|apprentice")],
  // "Developer 2.0" is a version, not level 2. A title that also names senior
  // ("Middle/Senior", "Regular/Senior", "Sr. Engineer II") is a range that
  // includes me: screening.ts lets it through.
  ["mid-level role, CV is senior", T("middle|mid(?![- ]?market)|mid[- ]?level|regular|engineer (?:2|ii)(?!\\.\\d)|developer (?:2|ii)(?!\\.\\d)")],
  ["management role, not engineering", T("head of|engineering manager|director|cto|vp|vice president|chief")],
  // AI-training gigs (rating model output, writing prompts for a lab) are not
  // engineering work, whatever the title says about TypeScript.
  ["AI-training gig, not engineering", T("ai training|ai trainer|ai tutor|data annotation|rlhf")],
  ["not an engineering role", T("recruiter|talent|designer|ui/ux design|product manager|project manager|scrum master|business analyst|analyst|account manager|customer success|support|advocate|consultant|informatyk|administrator|technical writer|documentation")],
  ["QA / test role", T("qa|test engineer|tester|sdet|quality|automation test|automation engineer")],
  // Infrastructure as code in the title is the role's point. The cloud alone
  // ("React / TypeScript / AWS") is not: on 2026-10-30 cloud became something
  // to learn on the job, DevOps work in earnest stayed out.
  ["DevOps / infra / security role", T("devops|sre|site reliability|security|cloud architect|platform lead|network|infrastructure|k8s|kubernetes|terraform|pulumi|cloudformation")],
  // Asked for on 2026-10-24: a role whose point is architecture is not the
  // hands-on product work wanted, React in the title or not.
  ["architect role, not hands-on product work", T("architect|architekt\\w*")],
  ["data / ML role", T("data engineer|data scientist|ml engineer|machine learning|deep learning|mlops|data visuali[sz]ation|computer vision")],
  // Since 2026-10-30 AI engineering is wanted where it is my experience — LLMs
  // in a TypeScript / Node product — so "AI Engineer" and "LLM Engineer" go to
  // Claude, which skips the Python and model-training ones. Infrastructure for
  // models and research stay out by title.
  ["AI infrastructure / research role", T("ai infrastructure|ai platform|ai research|research engineer|ai architect|solutions? architect")],
  ["mobile role", T("mobile|react native|android|ios|flutter|swift|kotlin|hybrid app")],
  ["wrong stack: .NET / Java", T("\\.net|c#|asp\\.net|java|jvm|spring|kotlin|scala")],
  ["wrong stack: other language", T("python|django|fastapi|ruby|rails|golang|go developer|go engineer|\\(go\\)|rust|elixir|erlang|c\\+\\+|embedded|unity|unreal")],
  ["wrong stack: other frontend framework", T("angular|angularjs|vue|svelte|ui5|sapui5|blazor")],
  ["wrong stack: platform / CMS / ERP", T("shopify|wordpress|drupal|magento|salesforce|sap|abap|sharepoint|power platform|dynamics 365|copilot studio|netsuite|1c|servicenow|low[- ]code|appian|mendix|outsystems|pega|webflow|website editor")],
  ["PHP-first role", T("php|laravel|symfony")],
  ["requires another language", T("german|deutsch|italian|french|spanish|dutch|polish speaker|with (?:german|italian|french|spanish|dutch)|(?:german|italian|french|spanish|dutch)[- ]speaking")],
];

/** How Settings → Rules names each rule, in English like the catalog's keys (the reasons above: hides store them). */
export const SCREEN_RULE_LABELS: Record<string, string> = {
  "junior/intern level": "Junior, intern",
  "mid-level role, CV is senior": "Mid-level",
  "management role, not engineering": "Management",
  "AI-training gig, not engineering": "AI data labelling",
  "not an engineering role": "Not an engineering role",
  "QA / test role": "QA, testing",
  "DevOps / infra / security role": "DevOps, infrastructure, security",
  "architect role, not hands-on product work": "Architect",
  "data / ML role": "Data, ML",
  "AI infrastructure / research role": "AI infrastructure and research",
  "mobile role": "Mobile development",
  "wrong stack: .NET / Java": ".NET, Java",
  "wrong stack: other language": "Another language: Python, Go, Ruby…",
  "wrong stack: other frontend framework": "Angular, Vue, Svelte",
  "wrong stack: platform / CMS / ERP": "Platforms, CMS, ERP",
  "PHP-first role": "PHP",
  "requires another language": "Another language required: German…",
};

/**
 * A role I applied to, reposted on another board, stays hidden this long
 * (src/screening.ts). Later it shows again with a flag: by then the first
 * application has gone quiet, and applying again can be a choice.
 */
export const REAPPLY_AFTER_DAYS = 60;

// Tested against the *normalised* title, so "Full-Stack" and "Node.js" match.
export const SCREEN_FRONTEND = T("react|frontend|fullstack|next|web|ui engineer|product engineer");
export const SCREEN_BACKEND_ONLY = T("node|nest|backend|microservices|api developer");

/**
 * Boards and marketplaces that hire through their own account/vetting flow.
 * The skills cannot create accounts, so these go to the "needs you" list.
 */
export const SCREEN_MARKETPLACES = T("lemon\\.io|jobgether|gitstart|proxify|micro1|alignerr|toptal|turing|crossover|upwork|braintrust|andela|arc\\.dev|remotepass");
