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
 *   - The verification code, a CAPTCHA, an account: never automated.
 *     Greenhouse and LinkedIn run headed on this machine, and the page tells me
 *     to type the code into that window. Every other ending lands in the
 *     attempts list ("нужно вам") through apply.mjs itself.
 *
 * Results come back the way apply.mjs reports them: one JSON line on stdout,
 * progress on stderr.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
};

const runs = new Map<string, ApplyRun>();
const busy = new Map<ApplyRun["profile"], string>();

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

/** Why this run may not start, or null when it may. */
export function refusal(key: string, job: Job, mode: ApplyMode): string | null {
  const holder = busy.get(profileFor(job));
  if (holder) {
    const other = runs.get(holder);
    return `another application is running in this Chrome profile (${other?.company ?? "?"})`;
  }
  if (mode === "submit") {
    const shown = [...runs.values()].some(
      (run) =>
        run.key === key &&
        run.mode === "dry-run" &&
        run.done &&
        run.result?.["result"] === "dry-run" &&
        Date.now() - run.startedAt < DRY_RUN_VALID_MS,
    );
    if (!shown) return "dry run first: submit is allowed only after its filled fields were shown";
  }
  return null;
}

export function startApply(key: string, job: Job, mode: ApplyMode, dashboardUrl: string): ApplyRun {
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
    "--stack", job.tags.slice(0, 12).join(","),
  ];
  if (job.location) args.push("--location", job.location);
  if (job.salary) args.push("--salary", job.salary);
  const contract = contractOf(job);
  if (contract) args.push("--contract", contract);
  if (mode === "dry-run") args.push("--dry-run");

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
