/**
 * verdict-eval.ts — Claude's verdicts checked against what I decided.
 *
 * Every criteria edit used to go straight to the background queue and re-judge
 * every shown card, with nothing to say whether the edit made the verdicts
 * better: an action followed only 7 of the first 120 verdicts, and the one set
 * of postings decided by hand (28, on 2026-10-23) sat in a temp folder. This
 * runs the criteria — the file as it is, or a draft — on postings whose right
 * answer is known, from their saved texts, and says where Claude and I differ.
 *
 * Where the right answers come from, strongest first:
 *   - «Верно» / «Мимо» on a card (verdict_feedback): the verdict it should have.
 *   - What I did after a verdict (decisions): hidden with a reason the posting's
 *     text carries (не remote, не тот стек, …) should be "skip"; added to the
 *     funnel, not "skip". Hides for reasons outside the text (already applied
 *     elsewhere, the company, pay below the floor — a "maybe" by design) are
 *     not labels.
 *   - The 2026-10-23 calibration (~/.job-hunt/eval/calibration-2026-10-23.jsonl):
 *     applied to or hidden by hand, before verdicts existed. Some of those hides
 *     were for reasons outside the text, which is why it agreed 20/28.
 * "borderline" is a different question: the current verdicts scored 20–70,
 * the ones a criteria edit tends to flip, run again to see what flips.
 *
 * Nothing is stored as a verdict. Runs go through `claude -p` like any verdict
 * (model and effort from Настройки) and are not counted in the daily cap.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  findPostings,
  getMeta,
  getPostingText,
  listDecisions,
  listFeedback,
  listVerdicts,
  resolveDbPath,
  setMeta,
  type DecisionRow,
} from "./db.ts";
import type { Job } from "./sources.ts";
import { criteriaVersion, judgeText, type Verdict } from "./verdict.ts";

/** "fit": anything but "skip" — what applying to a posting says about it. */
export type Expected = Verdict | "fit";
export type EvalSet = "labels" | "borderline";

export type GoldenRow = {
  key: string;
  title: string;
  company: string;
  source: string;
  url: string;
  text: string;
  expected: Expected;
  origin: "feedback" | "decision" | "calibration" | "stored";
  /** Why this is the right answer: the hide reason, «Мимо», the calibration. */
  note: string;
};

export type EvalRow = Omit<GoldenRow, "text"> & {
  got: Verdict | null;
  score: number | null;
  summary: string;
  ok: boolean;
  error: string | null;
};

export type EvalSummary = {
  at: string;
  set: EvalSet;
  /** The criteria version the run judged with; a draft's differs from the file's. */
  version: string;
  draft: boolean;
  n: number;
  ok: number;
  /** Agreement on the one thing every label says: skip or not. */
  skipAgree: number;
  errors: number;
  costUsd: number;
  seconds: number;
  /** Where Claude and the label differ, for the page. */
  misses: EvalRow[];
  stopped: string | null;
};

/** Hide reasons the posting's own text can carry: a hide with one says the verdict should be "skip". */
const TEXT_REASONS = new Set([
  "не remote",
  "не тот стек",
  "уровень (mid/junior)",
  "не из Польши",
  "не та роль",
  "нужен другой язык",
  "вакансия закрыта",
]);

function evalDir(): string {
  const dir = join(dirname(resolveDbPath()), "eval");
  mkdirSync(join(dir, "runs"), { recursive: true });
  return dir;
}

/** The text a verdict on this job read, else its longest stored description. */
function textFor(key: string, fallback = ""): string {
  const saved = getPostingText(key)?.text ?? "";
  const stored = findPostings(key)
    .map((job) => job.description ?? "")
    .sort((a, b) => b.length - a.length)[0] ?? "";
  return [saved, stored, fallback].sort((a, b) => b.length - a.length)[0] ?? "";
}

/** Enough text to judge, and not a bot check where the posting should be (Canonical's was 338 characters of Cloudflare). */
function readable(text: string): boolean {
  return text.length >= 300 && !/just a moment|performing security verification|verify you are (?:a )?human|checking your browser/i.test(text.slice(0, 800));
}

function boardData(key: string): Pick<GoldenRow, "title" | "company" | "source" | "url"> | null {
  const job = findPostings(key)[0];
  return job ? { title: job.title, company: job.company, source: job.source, url: job.url } : null;
}

/** The postings whose right answer is known, one row per job, strongest label first. */
export function goldenSet(): GoldenRow[] {
  const rows = new Map<string, GoldenRow>();
  const verdicts = new Map(listVerdicts().map((row) => [row.job_key, row]));
  const add = (row: GoldenRow) => {
    if (!rows.has(row.key) && readable(row.text)) rows.set(row.key, row);
  };

  for (const mark of listFeedback()) {
    const board = boardData(mark.job_key);
    const verdict = verdicts.get(mark.job_key);
    add({
      key: mark.job_key,
      title: board?.title ?? verdict?.title ?? "?",
      company: board?.company ?? verdict?.company ?? "?",
      source: board?.source ?? "?",
      url: board?.url ?? verdict?.url ?? `https://${mark.job_key}`,
      text: textFor(mark.job_key),
      expected: mark.expected as Verdict,
      origin: "feedback",
      note: mark.expected === mark.verdict ? "«Верно»" : `«Мимо»: было ${mark.verdict}`,
    });
  }

  // The latest action per job decides; a restore cancels a hide.
  const lastAction = new Map<string, DecisionRow>();
  for (const decision of listDecisions()) lastAction.set(decision.job_key, decision);
  for (const decision of lastAction.values()) {
    const expected: Expected | null =
      decision.action === "hide" && decision.reason && TEXT_REASONS.has(decision.reason)
        ? "skip"
        : decision.action === "funnel"
          ? "fit"
          : null;
    if (!expected) continue;
    const board = boardData(decision.job_key);
    const verdict = verdicts.get(decision.job_key);
    add({
      key: decision.job_key,
      title: board?.title ?? verdict?.title ?? "?",
      company: board?.company ?? verdict?.company ?? "?",
      source: board?.source ?? "?",
      url: board?.url ?? verdict?.url ?? `https://${decision.job_key}`,
      text: textFor(decision.job_key),
      expected,
      origin: "decision",
      note: decision.action === "hide" ? `скрыта: ${decision.reason}` : "в воронке",
    });
  }

  const calibration = join(evalDir(), "calibration-2026-10-23.jsonl");
  if (existsSync(calibration)) {
    for (const line of readFileSync(calibration, "utf8").split("\n").filter(Boolean)) {
      const row = JSON.parse(line) as { key: string; title: string; company: string; source: string; truth: string; reason: string | null; text: string | null };
      add({
        key: row.key,
        title: row.title,
        company: row.company,
        source: row.source,
        url: findPostings(row.key)[0]?.url ?? `https://${row.key}`,
        text: textFor(row.key, row.text ?? ""),
        expected: row.truth === "skip" ? "skip" : "fit",
        origin: "calibration",
        note: row.truth === "skip" ? `скрыта 23.10${row.reason ? `: ${row.reason}` : " без причины"}` : "откликался",
      });
    }
  }
  return [...rows.values()];
}

/** The current verdicts a criteria edit tends to flip — scored 20–70 — against themselves. */
export function borderlineSet(limit = 40): GoldenRow[] {
  const version = criteriaVersion();
  return listVerdicts()
    .filter((row) => row.criteria === version && (row.score ?? 0) >= 20 && (row.score ?? 0) <= 70)
    .sort((a, b) => Math.abs(50 - (a.score ?? 0)) - Math.abs(50 - (b.score ?? 0)))
    .map((row): GoldenRow => {
      const board = boardData(row.job_key);
      return {
        key: row.job_key,
        title: board?.title ?? row.title ?? "?",
        company: board?.company ?? row.company ?? "?",
        source: board?.source ?? "?",
        url: board?.url ?? row.url,
        text: textFor(row.job_key),
        expected: row.verdict,
        origin: "stored",
        note: `сейчас ${row.verdict}/${row.score}`,
      };
    })
    .filter((row) => readable(row.text))
    .slice(0, limit);
}

function matches(expected: Expected, got: Verdict): boolean {
  return expected === "fit" ? got !== "skip" : expected === got;
}

/** The posting as the prompt describes it: the stored copy when there is one. */
function jobFor(row: GoldenRow): Job {
  const stored = findPostings(row.key)[0];
  if (stored) return stored;
  return {
    source: row.source as Job["source"],
    externalId: row.key,
    title: row.title,
    company: row.company,
    url: row.url,
    location: null,
    remote: false,
    salary: null,
    salaryMin: null,
    salaryMax: null,
    tags: [],
    postedAt: null,
    locationRestrictions: [],
  };
}

/**
 * Judges every row, two at a time. A stop that would stop the verdict queue
 * too (the plan's limit, a lost login) ends the run with what it has.
 */
export async function runEval(
  rows: GoldenRow[],
  options: { set: EvalSet; criteriaText?: string; onProgress?: (done: number, total: number) => void },
): Promise<{ summary: EvalSummary; rows: EvalRow[] }> {
  const started = Date.now();
  const results: EvalRow[] = [];
  let version = options.criteriaText === undefined ? criteriaVersion() : "";
  let costUsd = 0;
  let stopped: string | null = null;
  let next = 0;
  const worker = async () => {
    while (next < rows.length && !stopped) {
      const row = rows[next++] as GoldenRow;
      const { text, ...meta } = row;
      try {
        const answer = await judgeText(jobFor(row), text, options.criteriaText);
        version = answer.version;
        costUsd += answer.costUsd ?? 0;
        const got = answer.output.verdict;
        results.push({ ...meta, got, score: answer.output.score, summary: answer.output.summary, ok: matches(row.expected, got), error: null });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // QueueStop carries `until`: the plan's limit or a lost login — no point going on.
        if (error && typeof error === "object" && "until" in error) stopped = message;
        results.push({ ...meta, got: null, score: null, summary: "", ok: false, error: message });
      }
      options.onProgress?.(results.length, rows.length);
    }
  };
  await Promise.all([worker(), worker()]);
  const judged = results.filter((row) => row.got !== null);
  const summary: EvalSummary = {
    at: new Date().toISOString(),
    set: options.set,
    version,
    draft: options.criteriaText !== undefined,
    n: judged.length,
    ok: judged.filter((row) => row.ok).length,
    skipAgree: judged.filter((row) => (row.expected === "skip") === (row.got === "skip")).length,
    errors: results.length - judged.length,
    costUsd: Math.round(costUsd * 100) / 100,
    seconds: Math.round((Date.now() - started) / 1000),
    misses: judged.filter((row) => !row.ok).slice(0, 30),
    stopped,
  };
  const file = join(evalDir(), "runs", `${summary.at.replace(/[:.]/g, "-")}-${options.set}.json`);
  writeFileSync(file, JSON.stringify({ summary, rows: results }, null, 2));
  if (!summary.draft) setMeta(LAST_KEY, JSON.stringify(summary));
  return { summary, rows: results };
}

/* ------------------------------------------------------------------ */
/* The run Настройки starts                                             */
/* ------------------------------------------------------------------ */

const LAST_KEY = "verdict_eval_last";
let running: { set: EvalSet; done: number; total: number } | null = null;

/** Starts a run of the current criteria in the background; false when one is going. */
export function startEval(set: EvalSet): { started: boolean; total: number } {
  if (running) return { started: false, total: running.total };
  const rows = set === "labels" ? goldenSet() : borderlineSet();
  running = { set, done: 0, total: rows.length };
  void runEval(rows, {
    set,
    onProgress: (done) => {
      if (running) running.done = done;
    },
  })
    .catch((error: unknown) => console.error(`verdict eval failed: ${error instanceof Error ? error.message : error}`))
    .finally(() => {
      running = null;
    });
  return { started: true, total: rows.length };
}

export function evalStatus() {
  let last: EvalSummary | null = null;
  try {
    last = JSON.parse(getMeta(LAST_KEY) ?? "null") as EvalSummary | null;
  } catch {
    // an unreadable row is no result
  }
  return {
    running,
    last,
    /** What each set would judge now, for the buttons. */
    sizes: { labels: goldenSet().length, borderline: borderlineSet().length },
    current: criteriaVersion(),
  };
}
