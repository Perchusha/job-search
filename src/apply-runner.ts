/**
 * apply-runner.ts — runs scripts/apply.mjs for one search card, on behalf of the
 * dashboard's "Подать" button.
 *
 * Rules, all enforced here rather than trusted to the page:
 *   - Dry run first. A submit is refused unless a dry run of the same job
 *     finished in the last 30 minutes and its filled fields were shown.
 *     Applications go out in my name; nothing is sent unseen.
 *   - One run per Chrome profile at a time. apply.mjs uses two fixed
 *     profiles (LinkedIn, everything else) and a second launch on the same
 *     profile fails.
 *   - Published pay under the floor (profile.ts SALARY) needs an explicit
 *     "apply anyway": two such applications went out unnoticed before.
 *   - The verification code, a CAPTCHA, an account: never automated.
 *     Greenhouse and LinkedIn run headed on this machine, and the page tells me
 *     to type the code into that window. Every other ending lands in the
 *     attempts list ("нужно вам") through apply.mjs itself.
 *   - Answers to the questions apply.mjs has no rule for (written in the
 *     panel, drafted by src/form-drafts.ts) go with a dry run as --answers.
 *     A submit sends what its dry run showed: it takes that run's answers,
 *     never new ones from the page. A job's answers are kept for its later
 *     dry runs until the server restarts.
 *
 * Results come back the way apply.mjs reports them: one JSON line on stdout,
 * progress on stderr.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { belowSalaryFloor } from "./boards-pl.ts";
import { officeAcceptable, postingStack } from "./profile.ts";
import type { Job } from "./sources.ts";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "apply.mjs");
const KILL_AFTER_MS = 10 * 60_000;
const DRY_RUN_VALID_MS = 30 * 60_000;
const KEEP_RUNS = 50;

export type ApplyMode = "dry-run" | "submit";

export type ApplyRun = {
  id: string;
  key: string;
  company: string;
  title: string;
  mode: ApplyMode;
  profile: "linkedin" | "ats";
  startedAt: number;
  done: boolean;
  exitCode: number | null;
  /** stderr, last lines: progress and the "type the code" prompt. */
  log: string[];
  /** The JSON line apply.mjs printed, once it has. */
  result: Record<string, unknown> | null;
  /** --answers: label substring → answer. */
  answers: Record<string, string>;
};

const runs = new Map<string, ApplyRun>();
const busy = new Map<ApplyRun["profile"], string>();
/** The answers each job's runs were given, by job key: a later dry run of the job starts from them. */
const given = new Map<string, Record<string, string>>();

const MAX_ANSWERS = 30;

/**
 * The page's answers, checked: label → non-empty text, a label as apply.mjs
 * reports it (cut at 200 characters), an answer no longer than a form takes.
 * null when the shape is wrong; {} when there are none.
 */
export function readAnswers(value: unknown): Record<string, string> | null {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_ANSWERS) return null;
  const answers: Record<string, string> = {};
  for (const [label, answer] of entries) {
    if (typeof answer !== "string" || label.trim().length === 0 || label.length > 400 || answer.length > 5000) return null;
    if (answer.trim()) answers[label.trim()] = answer.trim();
  }
  return answers;
}

function profileFor(job: Job): ApplyRun["profile"] {
  return /linkedin\.com/i.test(job.url) ? "linkedin" : "ats";
}

/** "uop" / "b2b" when every published pay range agrees; apply.mjs picks the salary figure by it. */
function contractOf(job: Job): "uop" | "b2b" | null {
  const contracts = new Set((job.pay ?? []).map((range) => range.contract));
  if (contracts.size !== 1) return null;
  const only = [...contracts][0];
  return only === "uop" || only === "b2b" ? only : null;
}

export function getRun(id: string): ApplyRun | null {
  return runs.get(id) ?? null;
}

/** The dry run a submit of this job may follow: finished, its filled fields shown, recent. */
function shownDryRun(key: string): ApplyRun | null {
  return (
    [...runs.values()].reverse().find(
      (run) =>
        run.key === key &&
        run.mode === "dry-run" &&
        run.done &&
        run.result?.["result"] === "dry-run" &&
        // A dry run that filled nothing showed nothing: there is no form to send.
        Array.isArray(run.result["filled"]) &&
        run.result["filled"].length > 0 &&
        Date.now() - run.startedAt < DRY_RUN_VALID_MS,
    ) ?? null
  );
}

/** Why this run may not start, or null when it may. `lowPay`: the page can offer "apply anyway". */
export function refusal(
  key: string,
  job: Job,
  mode: ApplyMode,
  acceptLowPay = false,
): { message: string; lowPay?: boolean } | null {
  const holder = busy.get(profileFor(job));
  if (holder) {
    const other = runs.get(holder);
    return { message: `another application is running in this Chrome profile (${other?.company ?? "?"})` };
  }
  if (!acceptLowPay && belowSalaryFloor(job)) {
    return { message: `the published pay (${job.salary ?? "?"}) is below your floor`, lowPay: true };
  }
  if (mode === "submit" && !shownDryRun(key)) {
    return { message: "dry run first: submit is allowed only after its filled fields were shown" };
  }
  return null;
}

/** `answers`: the page's, for a dry run; a submit ignores them and takes its dry run's. */
export function startApply(key: string, job: Job, mode: ApplyMode, dashboardUrl: string, answers: Record<string, string> = {}): ApplyRun {
  if (mode === "submit") answers = shownDryRun(key)?.answers ?? {};
  else {
    answers = { ...given.get(key), ...answers };
    if (Object.keys(answers).length > 0) given.set(key, answers);
  }
  const run: ApplyRun = {
    id: randomUUID(),
    key,
    company: job.company,
    title: job.title,
    mode,
    profile: profileFor(job),
    startedAt: Date.now(),
    done: false,
    exitCode: null,
    log: [],
    result: null,
    answers,
  };
  runs.set(run.id, run);
  busy.set(run.profile, run.id);
  // Old runs go; the page only follows the current one.
  for (const old of [...runs.keys()].slice(0, Math.max(0, runs.size - KEEP_RUNS))) runs.delete(old);

  const args = [
    SCRIPT,
    job.url,
    "--url", job.url,
    "--company", job.company,
    "--title", job.title,
    "--source", job.source,
    "--cover", "auto",
    // The CV terms the posting names, in its order: the cover letter's one
    // posting-specific sentence is built from them.
    "--stack", postingStack(job).slice(0, 12).join(","),
  ];
  if (job.location) args.push("--location", job.location);
  if (job.salary) args.push("--salary", job.salary);
  if (job.postedAt) args.push("--posted", job.postedAt);
  const contract = contractOf(job);
  if (contract) args.push("--contract", contract);
  // The published ranges: a salary field gets the posting's top where it is above my figure.
  if (job.pay?.length) args.push("--pay", JSON.stringify(job.pay));
  // Office days are fine at a giant in Warsaw, so LinkedIn's Hybrid tag must not stop the run.
  if (officeAcceptable(job)) args.push("--office-ok");
  if (mode === "dry-run") args.push("--dry-run");
  // A file, as apply.mjs takes them: several paragraphs with quotes do not survive a command line.
  const answersFile = join(tmpdir(), `job-hunt-answers-${run.id}.json`);
  if (Object.keys(answers).length > 0) {
    writeFileSync(answersFile, JSON.stringify(answers));
    args.push("--answers", answersFile);
  }

  const child = spawn(process.execPath, args, {
    env: { ...process.env, JOBHUNT_URL: dashboardUrl },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (line.trim()) run.log.push(line.trim());
    }
    run.log = run.log.slice(-40);
  });
  const timer = setTimeout(() => child.kill(), KILL_AFTER_MS);
  const finish = (code: number | null) => {
    clearTimeout(timer);
    rmSync(answersFile, { force: true });
    run.done = true;
    run.exitCode = code;
    const start = stdout.indexOf("{");
    try {
      run.result = start >= 0 ? (JSON.parse(stdout.slice(start)) as Record<string, unknown>) : null;
    } catch {
      run.result = null;
    }
    if (!run.result) {
      run.result = {
        result: code === null ? "timeout" : "crash",
        reason: run.log.slice(-2).join(" ") || `exit ${code}`,
      };
    }
    if (busy.get(run.profile) === run.id) busy.delete(run.profile);
  };
  child.on("error", (error) => {
    run.log.push(`could not start apply.mjs: ${error.message}`);
    finish(null);
  });
  child.on("close", (code) => finish(code));
  return run;
}
