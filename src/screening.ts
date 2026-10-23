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

import { belowSalaryFloor } from "./boards-pl.ts";
import { jobKey } from "./jobkey.ts";
import { workSignals } from "./workmode.ts";
import {
  SCREEN_BACKEND_ONLY,
  SCREEN_FRONTEND,
  SCREEN_MARKETPLACES,
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

export function titleTokens(title: string | null | undefined): Set<string> {
  return new Set(norm(title).split(" ").filter((token) => token.length > 1 && !TITLE_STOP.has(token)));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
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
};

export type ScreenDismissal = {
  url: string;
  url_key?: string | null;
  title: string | null;
  company: string | null;
  reason: string | null;
};

/**
 * Hide reasons a rule wrote, as opposed to a judgement about the role. They
 * are not evidence for the cross-reference rules (see the file header).
 */
const MACHINE_REASON = /^(duplicate|same role|company hidden|auto:)/i;

/** The explicit "не интересна компания" choice from the page's hide menu. */
export const COMPANY_REASON = "не интересна компания";

type Keyed<T> = T & { companyKey: string; tokens: Set<string> };

export type ScreenContext = {
  applications: Keyed<ScreenApplication>[];
  appliedKeys: Set<string>;
  /** The user's own role-level hides — what "same role hidden earlier" compares against. */
  roleHides: Keyed<ScreenDismissal>[];
  /** Companies hidden by explicit choice, or for 2+ distinct roles by hand. */
  blockedCompanies: Map<string, string>;
  appliedByCompany: Map<string, Keyed<ScreenApplication>[]>;
};

export function buildContext(
  applications: ScreenApplication[],
  dismissed: ScreenDismissal[],
): ScreenContext {
  const keyed = <T extends { company: string | null; title: string | null }>(row: T): Keyed<T> => ({
    ...row,
    companyKey: companyKey(row.company),
    tokens: titleTokens(row.title),
  });

  const apps = applications.map(keyed);
  const appliedByCompany = new Map<string, Keyed<ScreenApplication>[]>();
  for (const app of apps) {
    appliedByCompany.set(app.companyKey, [...(appliedByCompany.get(app.companyKey) ?? []), app]);
  }

  const own = dismissed.filter((row) => !MACHINE_REASON.test(row.reason ?? "")).map(keyed);

  // A company counts as "not interested" when I said so, or when I hid two or
  // more *different* roles there by hand, with no reason, and never applied.
  // Reposts of one role are one role; role-specific reasons (junior, not
  // remote, wrong stack) are about the role, not the company.
  const blockedCompanies = new Map<string, string>();
  const handRoles = new Map<string, Set<string>[]>();
  for (const row of own) {
    if (!row.companyKey) continue;
    if (row.reason === COMPANY_REASON) {
      blockedCompanies.set(row.companyKey, "компания скрыта вручную");
      continue;
    }
    if (row.reason) continue;
    const roles = handRoles.get(row.companyKey) ?? [];
    if (!roles.some((tokens) => jaccard(tokens, row.tokens) >= 0.5)) roles.push(row.tokens);
    handRoles.set(row.companyKey, roles);
  }
  for (const [company, roles] of handRoles) {
    if (roles.length >= 2 && !appliedByCompany.has(company) && !blockedCompanies.has(company)) {
      blockedCompanies.set(company, `компания: скрыто ${roles.length} разных ролей, откликов нет`);
    }
  }

  return {
    applications: apps,
    appliedKeys: new Set(apps.map((app) => app.url_key ?? (app.url ? jobKey(app.url) : "")).filter(Boolean)),
    roleHides: own,
    blockedCompanies,
    appliedByCompany,
  };
}

/* ------------------------------------------------------------------ */
/* Decide                                                              */
/* ------------------------------------------------------------------ */

export type Bucket = "apply" | "check" | "needs-you" | "dismiss" | "skip";

export type Decision = {
  bucket: Bucket;
  reason: string;
  /** Things worth knowing that do not hide the card: earlier applications here. */
  flags: string[];
};

export type ScreenJob = {
  title: string;
  company: string;
  url: string;
  source: string;
  postedAt: string | null;
  dismissed?: boolean;
  eligibility?: { level: string; reason: string };
  /** Posting text, when the board gave one — for the language rule. */
  description?: string | null;
  salary?: string | null;
  pay?: import("./sources.ts").PayRange[];
  /** Already computed by presentJob (funnel.mjs screens presented jobs). */
  belowSalaryFloor?: boolean;
};

const STALE_DAYS = 60;

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
  if (job.belowSalaryFloor ?? belowSalaryFloor(job as Parameters<typeof belowSalaryFloor>[0])) {
    flags.push(`зарплата ниже порога: ${job.salary ?? "?"}`);
  }

  if (job.dismissed) return { bucket: "skip", reason: "already hidden", flags };
  if (context.appliedKeys.has(jobKey(job.url))) {
    return { bucket: "skip", reason: "already in the funnel", flags };
  }

  // The same role at a company I applied to: a flag, never a hide.
  for (const app of context.applications) {
    if (sameCompany(company, app.companyKey) && jaccard(tokens, app.tokens) >= 0.5) {
      flags.unshift(`похоже на отклик #${app.id} (${app.status}): ${app.title}`);
      break;
    }
  }

  for (const hidden of context.roleHides) {
    if (sameCompany(company, hidden.companyKey) && jaccard(tokens, hidden.tokens) >= 0.5) {
      return { bucket: "dismiss", reason: `same role hidden earlier: ${hidden.title}`, flags };
    }
  }

  for (const [key, why] of context.blockedCompanies) {
    if (sameCompany(company, key)) return { bucket: "dismiss", reason: why, flags };
  }

  for (const [reason, pattern] of SCREEN_TITLE_RULES) {
    if (pattern.test(title)) {
      // "Russian speaker" is fine — native language.
      if (reason.startsWith("requires") && /russian/i.test(title)) continue;
      // "AI" in a frontend/fullstack title is a bonus, not the role.
      if (reason.startsWith("AI/ML") && SCREEN_FRONTEND.test(title)) continue;
      if (reason.startsWith("QA") && SCREEN_FRONTEND.test(title) && !/\bqa\b|tester|sdet/i.test(title)) continue;
      return { bucket: "dismiss", reason, flags };
    }
  }

  // Polish B1 is not "fluent Polish". The title rule above only sees titles.
  if (workSignals(job).polishRequired) {
    return { bucket: "dismiss", reason: "requires fluent Polish (per posting)", flags };
  }

  if (SCREEN_BACKEND_ONLY.test(plain) && !SCREEN_FRONTEND.test(plain)) {
    return { bucket: "dismiss", reason: "backend-only role", flags };
  }

  const age = ageDays(job.postedAt);
  if (age !== null && age > STALE_DAYS) {
    return { bucket: "dismiss", reason: `posting is ${age} days old`, flags };
  }

  // A second posting of the same role inside this very pass.
  for (const previous of earlier) {
    if (previous.bucket === "dismiss" || previous.bucket === "skip") continue;
    if (
      sameCompany(company, companyKey(previous.job.company)) &&
      jaccard(tokens, titleTokens(previous.job.title)) >= 0.5
    ) {
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
  if (job.source === "indeed" && /^onsite\/hybrid/i.test(geo)) {
    return { bucket: "dismiss", reason: "not remote (onsite/hybrid per Indeed)", flags };
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
