/**
 * screening.ts — my own screening rules, applied to a search result.
 *
 * These used to run only after the search, in scripts/funnel.mjs, driven by the
 * job-screen skill: a card had to be shown, read and hidden by hand first. Run
 * against the database they would have caught 137 of the 277 jobs I had hidden
 * by hand without a reason. So the search applies them itself, at read time:
 * nothing is written to the dismissed table (hiding stays an explicit act), and
 * the page keeps every rule hit behind a "скрыто правилами" toggle with its
 * reason, because the rules do misfire.
 *
 * The rule lists are personal and live in profile.ts. This file is mechanics:
 * how "the same role" and "the same company" are recognised, and the order the
 * rules run in. funnel.mjs imports decide() from here.
 *
 * Two lessons from the first scripted pass are built in:
 *   - Hides written by the rules themselves ("duplicate posting of …", "same
 *     role hidden earlier", "company hidden N×") never count as evidence. They
 *     were feeding the cross-reference rules, which then hid a surviving copy
 *     of a role, or banned a company on the strength of its own reposts.
 *   - A role similar to one I applied to is a flag, not a hide: I applied to
 *     EPAM's Lead and Senior full-stack openings on purpose.
 */

import { payVsFloor } from "./boards-pl.ts";
import { jobKey } from "./jobkey.ts";
import { preferences } from "./preferences.ts";
import { workSignals } from "./workmode.ts";
import {
  OFFICE_OK,
  REAPPLY_AFTER_DAYS,
  WATCHLIST,
  SCREEN_BACKEND_ONLY,
  SCREEN_FRONTEND,
  SCREEN_MARKETPLACES,
  SCREEN_RULE_LABELS,
  SCREEN_TITLE_RULES,
} from "./profile.ts";

/* ------------------------------------------------------------------ */
/* Normalisation — how "the same role" is recognised                   */
/* ------------------------------------------------------------------ */

const CANON: Array<[RegExp, string]> = [
  [/full[\s-]*stack/g, "fullstack"],
  [/front[\s-]*end/g, "frontend"],
  [/back[\s-]*end/g, "backend"],
  [/react[\s.]*js\b/g, "react"],
  [/node[\s.]*js\b/g, "node"],
  [/next[\s.]*js\b/g, "next"],
  [/nest[\s.]*js\b/g, "nest"],
  [/vue[\s.]*js\b/g, "vue"],
  [/type[\s-]*script/g, "typescript"],
  [/java[\s-]*script/g, "javascript"],
];

export function norm(value: string | null | undefined): string {
  let text = (value ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  for (const [pattern, replacement] of CANON) text = text.replace(pattern, replacement);
  return text.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

// Words that say nothing about *which* role it is.
const TITLE_STOP = new Set(
  "senior sr lead staff principal expert mid middle regular junior developer engineer software programista the and with of a an m f d x k nb w remote in at to for team specialist".split(
    " ",
  ),
);

/** Words that tag a listing rather than name the role: gender markers, the work mode, the country. */
const TAG_WORDS = new Set("m f d x k n nb w remote zdalnie hybrid poland polska".split(" "));

/**
 * The title as one role across boards: normalised, listing tags dropped, the
 * level kept — "Senior Frontend Engineer (m/f/d)" and "Senior Front-end
 * Engineer" are one role, the Lead and Senior openings of a team are two.
 */
export function roleKey(title: string | null | undefined): string {
  return norm(title)
    .split(" ")
    .filter((word) => word.length > 0 && !TAG_WORDS.has(word))
    .join(" ");
}

export function titleTokens(title: string | null | undefined): Set<string> {
  return new Set(norm(title).split(" ").filter((token) => token.length > 1 && !TITLE_STOP.has(token)));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  // Two titles that name no role ("Senior Software Engineer", "Lead Developer")
  // share nothing: at 1 they were one role, and one hide took them all.
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Title words that say where or on what contract, not which role. */
const NOISE_WORDS = new Set(
  "b2b uop contract warsaw warszawa krakow cracow wroclaw gdansk poznan lodz katowice europe emea eu ii iii iv vi 1 2 3 4 5 6 7 100".split(" "),
);

/** The words of a title that name the role: no level, no place or contract, nothing from the company's own name. */
function roleWords(title: string | null | undefined, company: string): Set<string> {
  const own = new Set(company.split(" "));
  return new Set([...titleTokens(title)].filter((word) => !NOISE_WORDS.has(word) && !own.has(word)));
}

const SENIOR_WORD = /\b(?:senior|sr|lead|staff|principal|starszy|expert)\b/i;
const JUNIOR_RULE = SCREEN_TITLE_RULES.find(([reason]) => reason.startsWith("junior"))?.[1];
const MID_RULE = SCREEN_TITLE_RULES.find(([reason]) => reason.startsWith("mid-level"))?.[1];

/** "junior" / "mid" / "senior" / "" (not said): the level words strip from titleTokens. */
function levelOf(title: string | null | undefined): string {
  const text = title ?? "";
  if (JUNIOR_RULE?.test(text)) return "junior";
  if (SENIOR_WORD.test(text)) return "senior";
  if (MID_RULE?.test(text)) return "mid";
  return "";
}

type RoleShape = { role: string; words: Set<string>; level: string };

/**
 * One role, for "same role hidden earlier" and the duplicate in a pass: the
 * same title once listing tags are gone, or — with a different wording — at
 * least three words that name the role on both sides, more than half of them
 * shared, and the same level. Compared on one or two words, titles of one company
 * matched like "Full Stack Engineer" and "Senior / Principal Full Stack
 * Software Engineer", and four of five such pairs were different postings by
 * their text; a hidden mid-level opening hid the senior one.
 */
export function sameRole(a: RoleShape, b: RoleShape): boolean {
  if (a.role.length > 0 && a.role === b.role) return true;
  if (a.level !== b.level || a.words.size < 3 || b.words.size < 3) return false;
  // More than half: at exactly half, Balyasny's "Front End Engineer, Risk
  // Technology" was the hidden "…, Execution Technology" — another team.
  return jaccard(a.words, b.words) > 0.5;
}

function shapeOf(title: string | null | undefined, company: string): RoleShape {
  return { role: roleKey(title), words: roleWords(title, company), level: levelOf(title) };
}

const COMPANY_SUFFIX =
  /\b(sp z o ?o|sp z oo|s a|sa|ltd|limited|inc|llc|gmbh|ag|plc|group|poland|polska|technologies|technology|solutions|software house|co)\b/g;

export function companyKey(company: string | null | undefined): string {
  return norm(company).replace(COMPANY_SUFFIX, " ").replace(/\s+/g, " ").trim();
}

export function sameCompany(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short + " ");
}

/* ------------------------------------------------------------------ */
/* Context — what the funnel and the hidden list already say           */
/* ------------------------------------------------------------------ */

export type ScreenApplication = {
  id: number;
  title: string;
  company: string;
  status: string;
  url: string | null;
  url_key?: string | null;
  applied_at?: string;
  source?: string | null;
};

export type ScreenDismissal = {
  url: string;
  url_key?: string | null;
  title: string | null;
  company: string | null;
  reason: string | null;
  dismissed_at?: string;
};

/**
 * Hide reasons a rule wrote, as opposed to a judgement about the role. They
 * are not evidence for the cross-reference rules (see the file header).
 */
const MACHINE_REASON = /^(duplicate|same role|company hidden|already applied|auto:|компания[: ])/i;

const BACKEND_RULE = "backend-only role";
const POLISH_RULE = "requires fluent Polish (per posting)";
const INDEED_ONSITE_RULE = "not remote (onsite/hybrid per Indeed)";
/** The id of the age rule; its reason names the age ("posting is 75 days old"). */
const STALE_RULE = "stale";
const STALE_DAYS = 60;

/**
 * Reasons decide() itself returns. Until funnel.mjs --commit started writing
 * "auto: …", it wrote them bare — 49 hides from the 10-13 run read exactly
 * like this — and they were taken for my own judgement: "backend-only role"
 * at Flosum went on to hide another role there as "same role hidden earlier".
 */
const RULE_REASONS = new Set([
  ...SCREEN_TITLE_RULES.map(([reason]) => reason),
  BACKEND_RULE,
  POLISH_RULE,
  INDEED_ONSITE_RULE,
  "marketplace / aggregator — needs an account, apply by hand",
]);

function machineReason(reason: string | null): boolean {
  if (!reason) return false;
  return MACHINE_REASON.test(reason) || RULE_REASONS.has(reason) || /^posting is \d+ days old$/.test(reason);
}

/** The explicit "не интересна компания" choice from the page's hide menu. */
export const COMPANY_REASON = "не интересна компания";

/* ------------------------------------------------------------------ */
/* The rules Настройки → Правила can switch off                        */
/* ------------------------------------------------------------------ */

export type ScreenRule = {
  /** The reason a hit gives, for all but the age rule ("stale"). */
  id: string;
  label: string;
  /** What a title rule looks for: its pattern's alternatives without regex syntax. */
  words: string[];
  /** For the rules that read more than the title. */
  note: string;
};

/** "new[- ]grad" → "new-grad", "praktyk\w*" → "praktyk…": the pattern as words, split at its top-level alternatives. */
function patternWords(pattern: RegExp): string[] {
  const inner = /^\(\?<!\[a-z0-9\]\)\(\?:(.*)\)\(\?!\[a-z0-9\]\)$/.exec(pattern.source)?.[1] ?? pattern.source;
  const words: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "\\") i++;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "|" && depth === 0) {
      words.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  words.push(inner.slice(start));
  return words.map((word) =>
    word
      .replace(/\(\?<?[!=][^)]*\)/g, "")
      .replace(/\(\?:([^)]*)\)/g, (_, alternatives: string) => alternatives.split("|").join("/"))
      .replace(/\[- \]\??/g, "-")
      .replace(/\[([a-z])[a-z]*\]/g, "$1")
      .replace(/\\w\*/g, "…")
      .replace(/(\w)\?/g, "$1")
      .replace(/\\(.)/g, "$1"),
  );
}

/**
 * Every rule that hides a card for what the posting says, in the order they
 * run. Not here: the memory rules (already applied to the role, the same role
 * hidden earlier, a blocked company, a second copy in one pass) — those are
 * about my own earlier acts, not the posting.
 */
export const SCREEN_RULES: ScreenRule[] = [
  ...SCREEN_TITLE_RULES.map(([reason, pattern]) => ({
    id: reason,
    label: SCREEN_RULE_LABELS[reason] ?? reason,
    words: patternWords(pattern),
    note: "",
  })),
  { id: POLISH_RULE, label: "Польский выше моего", words: [], note: "по тексту вакансии; мой уровень — в «Мои условия»" },
  {
    id: BACKEND_RULE,
    label: "Только бэкенд",
    words: patternWords(SCREEN_BACKEND_ONLY),
    note: "когда в заголовке нет React, frontend, fullstack, web",
  },
  { id: STALE_RULE, label: `Старше ${STALE_DAYS} дней`, words: [], note: "кроме тех, что площадка ещё показывает" },
  { id: INDEED_ONSITE_RULE, label: "Офис или гибрид по Indeed", words: [], note: "формат помечает сам Indeed" },
];

/** The rule behind a hit's reason; null for the memory rules and anything else. */
export function ruleOf(reason: string): string | null {
  if (/^posting is \d+ days old$/.test(reason)) return STALE_RULE;
  return SCREEN_RULES.some((rule) => rule.id === reason) ? reason : null;
}

type Keyed<T> = T & RoleShape & { companyKey: string; tokens: Set<string> };

export type ScreenContext = {
  applications: Keyed<ScreenApplication>[];
  appliedKeys: Set<string>;
  /** The user's own role-level hides — what "same role hidden earlier" compares against. */
  roleHides: Keyed<ScreenDismissal>[];
  /** Companies hidden by explicit choice, or for 2+ distinct roles by hand. */
  blockedCompanies: Map<string, string>;
  appliedByCompany: Map<string, Keyed<ScreenApplication>[]>;
  /** Rules switched off in Настройки → Правила (SCREEN_RULES ids). */
  rulesOff: Set<string>;
  /** Cards I said a rule was wrong about (db.ts rule_overrides): no hiding rule applies to them. */
  freed: Set<string>;
};

export type ContextOptions = {
  /** Keys of the cards freed by «Правило ошиблось». */
  overrides?: string[];
  /** Rules switched off; «Мои условия» `rulesOff` when not given. */
  rulesOff?: string[];
  /** Companies (companyKey) given back from a block in Настройки → Компании и память. */
  forgetCompanies?: string[];
  /** Hides (their job keys) that no longer teach anything: «забыть». */
  forgetHides?: string[];
  /** Only hides this recent count as memory; 0 is all. «Мои условия» `memoryDays` when not given. */
  memoryDays?: number;
};

/** A hide's job key, as the forget list stores it. */
export function hideKey(row: { url: string; url_key?: string | null }): string {
  return row.url_key ?? jobKey(row.url);
}

export function buildContext(
  applications: ScreenApplication[],
  dismissed: ScreenDismissal[],
  options: ContextOptions = {},
): ScreenContext {
  const keyed = <T extends { company: string | null; title: string | null }>(row: T): Keyed<T> => ({
    ...row,
    ...shapeOf(row.title, companyKey(row.company)),
    companyKey: companyKey(row.company),
    tokens: titleTokens(row.title),
  });

  const apps = applications.map(keyed);
  const appliedByCompany = new Map<string, Keyed<ScreenApplication>[]>();
  for (const app of apps) {
    appliedByCompany.set(app.companyKey, [...(appliedByCompany.get(app.companyKey) ?? []), app]);
  }

  // What my hides teach: not what a rule wrote, not what I said to forget,
  // and with a memory window only the recent ones — except "не интересна
  // компания", a choice about the company rather than evidence.
  const forgotten = new Set(options.forgetHides ?? []);
  const days = options.memoryDays ?? preferences().memoryDays;
  const since = days > 0 ? Date.now() - days * 86_400_000 : null;
  const recent = (row: ScreenDismissal) =>
    since === null || row.reason === COMPANY_REASON || !row.dismissed_at || Date.parse(row.dismissed_at) >= since;
  const own = dismissed.filter((row) => !machineReason(row.reason) && !forgotten.has(hideKey(row)) && recent(row)).map(keyed);
  const givenBack = new Set(options.forgetCompanies ?? []);

  // A company counts as "not interested" when I said so, or when I hid two or
  // more *different* roles there by hand, with no reason, and never applied.
  // Reposts of one role are one role; role-specific reasons (junior, not
  // remote, wrong stack) are about the role, not the company. Only roles I
  // would otherwise have wanted count — a frontend or fullstack title no rule
  // removes: hiding "Copilot Studio Developer" twice says nothing about a
  // company's React roles, and 12 of 30 blocks on 2026-10-24 stood on such
  // hides. Companies whose boards I read (WATCHLIST) and the giants whose
  // offices I accept (OFFICE_OK) are blocked only when I say so.
  const blockedCompanies = new Map<string, string>();
  const handRoles = new Map<string, Keyed<ScreenDismissal>[]>();
  for (const row of own) {
    if (!row.companyKey || givenBack.has(row.companyKey)) continue;
    if (row.reason === COMPANY_REASON) {
      blockedCompanies.set(row.companyKey, "компания скрыта вручную");
      continue;
    }
    if (row.reason || !targetTitle(row.title) || chosenCompany(row.company ?? "")) continue;
    const roles = handRoles.get(row.companyKey) ?? [];
    if (!roles.some((role) => role.role === row.role || jaccard(role.tokens, row.tokens) >= 0.5)) roles.push(row);
    handRoles.set(row.companyKey, roles);
  }
  for (const [company, roles] of handRoles) {
    if (roles.length >= 2 && !appliedByCompany.has(company) && !blockedCompanies.has(company)) {
      const evidence = roles.slice(0, 2).map((role) => `${shortDate(role.dismissed_at)} ${role.title}`).join("; ");
      blockedCompanies.set(company, `компания: скрыто ${roles.length} разных ролей без причины, откликов нет (${evidence})`);
    }
  }

  return {
    applications: apps,
    appliedKeys: new Set(apps.map((app) => app.url_key ?? (app.url ? jobKey(app.url) : "")).filter(Boolean)),
    roleHides: own,
    blockedCompanies,
    appliedByCompany,
    rulesOff: new Set(options.rulesOff ?? preferences().rulesOff),
    freed: new Set(options.overrides ?? []),
  };
}

/* ------------------------------------------------------------------ */
/* Decide                                                              */
/* ------------------------------------------------------------------ */

/** A frontend or fullstack title that no title rule removes: a role I would have looked at. */
function targetTitle(title: string | null): boolean {
  return SCREEN_FRONTEND.test(norm(title)) && !SCREEN_TITLE_RULES.some(([, pattern]) => pattern.test(title ?? ""));
}

const WATCHED = new Set(WATCHLIST.map((board) => companyKey(board.company)));

/** A company I chose to follow (WATCHLIST) or a giant whose office I accept: blocked only by an explicit choice. */
function chosenCompany(company: string): boolean {
  return WATCHED.has(companyKey(company)) || OFFICE_OK.companies.test(company);
}

function shortDate(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleDateString("ru", { day: "2-digit", month: "2-digit" }) : "?";
}

export type Bucket = "apply" | "check" | "needs-you" | "dismiss" | "skip";

export type Decision = {
  bucket: Bucket;
  reason: string;
  /** Things worth knowing that do not hide the card: earlier applications here. */
  flags: string[];
  /** For a hide from memory: the hide (its job key) or the blocked company (companyKey) it stands on. */
  memory?: { kind: "hide" | "company"; key: string };
};

export type ScreenJob = {
  title: string;
  company: string;
  url: string;
  source: string;
  postedAt: string | null;
  dismissed?: boolean;
  eligibility?: { level: string; reason: string };
  /** Keys of the copies dedupe folded into this one: an application to any of them counts. */
  aliasKeys?: string[];
  /** Still listed by a board read whole each pass: open, whatever its date says. */
  listed?: boolean;
  /** Posting text, when the board gave one — for the language rule. */
  description?: string | null;
  salary?: string | null;
  pay?: import("./sources.ts").PayRange[];
  /** Already computed by presentJob (funnel.mjs screens presented jobs). */
  belowSalaryFloor?: boolean;
  payState?: "below" | "midlow" | "ok" | null;
};

function ageDays(postedAt: string | null): number | null {
  if (!postedAt) return null;
  const ms = Date.now() - new Date(postedAt).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null;
}

function companyFlags(context: ScreenContext, company: string): string[] {
  for (const [key, apps] of context.appliedByCompany) {
    if (!sameCompany(company, key)) continue;
    const rejected = apps.filter((app) => app.status === "rejected");
    return [
      `откликался сюда ${apps.length}× (${apps.map((app) => `#${app.id} ${app.status}`).join(", ")})` +
        (rejected.length > 0 ? `, отказов: ${rejected.length}` : ""),
    ];
  }
  return [];
}

/**
 * One job against the rules. `earlier` is the decisions already made in this
 * pass, in rank order, for the in-pass duplicate rule.
 */
export function decide(
  job: ScreenJob,
  context: ScreenContext,
  earlier: Array<{ job: ScreenJob; bucket: Bucket; index: number }> = [],
): Decision {
  const title = job.title;
  const plain = norm(title);
  const company = companyKey(job.company);
  const tokens = titleTokens(title);
  const flags = companyFlags(context, company);
  // Known pay under the floor: a flag, not a hide — the user did apply to
  // some on purpose — but never again by accident (Bold, Scalo).
  // The middle under the floor is Claude's doubt in the criteria; said here
  // too, so the card and the verdict agree.
  const pay = job.payState !== undefined ? job.payState : job.belowSalaryFloor ? "below" : payVsFloor(job);
  if (pay === "below") flags.push(`зарплата ниже порога: ${job.salary ?? "?"}`);
  else if (pay === "midlow") flags.push(`середина вилки ниже порога: ${job.salary ?? "?"}`);

  if (job.dismissed) return { bucket: "skip", reason: "already hidden", flags };
  const keys = [jobKey(job.url), ...(job.aliasKeys ?? [])];
  if (keys.some((key) => context.appliedKeys.has(key))) {
    return { bucket: "skip", reason: "already in the funnel", flags };
  }
  // «Правило ошиблось» on this card or a copy dedupe folded into it: nothing hides it again.
  const freed = keys.some((key) => context.freed.has(key));
  const on = (rule: string) => !freed && !context.rulesOff.has(rule);

  // The same role applied to through another board: same company, same title
  // once listing tags are gone. Its link differs, so the check above misses
  // it, and Xebia's and ElevenLabs' copies reached «Подходят» with apply 84
  // and 78. A rule hit, so neither the stacks nor Claude's queue take it. The
  // title must name the role — two "Senior Software Engineer" openings at one
  // company are not one job — and the application must be recent: after
  // REAPPLY_AFTER_DAYS a repost is shown again, flagged below.
  if (tokens.size > 0 && !freed) {
    const role = roleKey(title);
    const applied = context.applications.find(
      (app) => app.role === role && sameCompany(company, app.companyKey) && (ageDays(app.applied_at ?? null) ?? 0) <= REAPPLY_AFTER_DAYS,
    );
    if (applied) {
      const on = applied.applied_at ? new Date(applied.applied_at).toLocaleDateString("ru", { day: "2-digit", month: "2-digit" }) : "?";
      return {
        bucket: "dismiss",
        reason: `already applied to this role: #${applied.id} (${applied.status}, ${applied.source ?? "?"}, ${on})`,
        flags,
      };
    }
  }

  // The same role at a company I applied to: a flag, never a hide.
  for (const app of context.applications) {
    if (sameCompany(company, app.companyKey) && jaccard(tokens, app.tokens) >= 0.5) {
      flags.unshift(`похоже на отклик #${app.id} (${app.status}): ${app.title}`);
      break;
    }
  }

  for (const [reason, pattern] of SCREEN_TITLE_RULES) {
    if (!on(reason) || !pattern.test(title)) continue;
    // "Russian speaker" is fine — native language.
    if (reason.startsWith("requires") && /russian/i.test(title)) continue;
    // "AI" in a frontend/fullstack title is a bonus, not the role. Tested on
    // the normalised title, as SCREEN_FRONTEND expects: on the raw one
    // "Full-Stack AI Engineer" had no "fullstack" and went as an AI role.
    if (reason.startsWith("AI/ML") && SCREEN_FRONTEND.test(plain)) continue;
    if (reason.startsWith("QA") && SCREEN_FRONTEND.test(plain) && !/\bqa\b|tester|sdet/i.test(title)) continue;
    // A level range that reaches senior: "Middle/Senior", "Regular/Senior",
    // "Sr. Software Engineer II / Tech lead". 6 of 12 hits on 2026-10-24.
    if (reason.startsWith("mid-level") && SENIOR_WORD.test(title)) continue;
    // "Mobile" as one platform of several: "React / Electron Developer (Web +
    // Mobile + Desktop)". A native stack named in the title still hides it.
    if (reason === "mobile role" && /\b(?:web|frontend|desktop)\b/.test(plain)
      && !/react native|android|\bios\b|flutter|swift|kotlin/i.test(title)) continue;
    return { bucket: "dismiss", reason, flags };
  }

  // Polish B1 is not "fluent Polish". The title rule above only sees titles.
  if (on(POLISH_RULE) && workSignals(job).polishRequired) {
    return { bucket: "dismiss", reason: POLISH_RULE, flags };
  }

  if (on(BACKEND_RULE) && SCREEN_BACKEND_ONLY.test(plain) && !SCREEN_FRONTEND.test(plain)) {
    return { bucket: "dismiss", reason: BACKEND_RULE, flags };
  }

  const age = ageDays(job.postedAt);
  if (on(STALE_RULE) && age !== null && age > STALE_DAYS && !job.listed) {
    return { bucket: "dismiss", reason: `posting is ${age} days old`, flags };
  }

  // What my earlier hides say, after what the posting itself says: the card
  // then shows the concrete reason when there is one (backend-only, mid-level)
  // rather than "same role hidden earlier".
  const shape = shapeOf(title, company);
  for (const hidden of freed ? [] : context.roleHides) {
    if (sameCompany(company, hidden.companyKey) && sameRole(shape, hidden)) {
      const why = hidden.reason ? `«${hidden.reason}»` : "без причины";
      return {
        bucket: "dismiss",
        reason: `same role hidden earlier (${shortDate(hidden.dismissed_at)}, ${why}): ${hidden.title}`,
        flags,
        memory: { kind: "hide", key: hideKey(hidden) },
      };
    }
  }

  for (const [key, why] of freed ? [] : context.blockedCompanies) {
    if (sameCompany(company, key)) return { bucket: "dismiss", reason: why, flags, memory: { kind: "company", key } };
  }

  // A second posting of the same role inside this very pass.
  for (const previous of freed ? [] : earlier) {
    if (previous.bucket === "dismiss" || previous.bucket === "skip") continue;
    const previousCompany = companyKey(previous.job.company);
    if (sameCompany(company, previousCompany) && sameRole(shape, shapeOf(previous.job.title, previousCompany))) {
      return {
        bucket: "dismiss",
        reason: `duplicate posting of #${previous.index} ${previous.job.title} (${previous.job.source})`,
        flags,
      };
    }
  }

  if (SCREEN_MARKETPLACES.test(job.company) || SCREEN_MARKETPLACES.test(job.url)) {
    return { bucket: "needs-you", reason: "marketplace / aggregator — needs an account, apply by hand", flags };
  }

  const geo = job.eligibility?.reason ?? "";
  // A giant's office in Warsaw (profile.ts OFFICE_OK) scores `high` with its
  // own reason, so it never reaches this rule.
  if (on(INDEED_ONSITE_RULE) && job.source === "indeed" && /^onsite\/hybrid/i.test(geo)) {
    return { bucket: "dismiss", reason: INDEED_ONSITE_RULE, flags };
  }
  if (job.eligibility?.level === "high") return { bucket: "apply", reason: geo, flags };
  return { bucket: "check", reason: geo, flags };
}

/** decide() over a ranked list, in order, so in-pass duplicates resolve to the first copy. */
export function screenAll<T extends ScreenJob>(jobs: T[], context: ScreenContext): Array<{ job: T } & Decision> {
  const earlier: Array<{ job: ScreenJob; bucket: Bucket; index: number }> = [];
  return jobs.map((job, index) => {
    const decision = decide(job, context, earlier);
    earlier.push({ job, bucket: decision.bucket, index });
    return { job, ...decision };
  });
}
