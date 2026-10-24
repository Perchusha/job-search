#!/usr/bin/env node
/**
 * apply-batch.mjs — run apply.mjs over a list of fetched postings, one line
 * of output per job, results saved as JSON. The model reads the lines, not
 * the forms.
 *
 *   node scripts/apply-batch.mjs --fetched <fetched.json> [--only 2,10,19] [--skip 5] [--out results.json]
 *                                [--submit] [--force 3,7] [--accept-low-pay 4]
 *
 * A dry run unless --submit: every form is filled and nothing is sent, as
 * «Подать» on the dashboard always starts. "Applications go out in my name;
 * nothing is sent unseen" (src/apply-runner.ts) — show the dry-run lines to the
 * user and re-run with --submit (and --only) for the ones they approve.
 *
 * A row is attempted when it has no `error`, is not `closed`, its applyVendor
 * is one apply.mjs can drive (not portal / himalayas-account / indeed), and the
 * stops «Подать» has hold (rows carry them from funnel.mjs screen through
 * jobs-fetch.mjs):
 *   - Claude's verdict is a current "apply". maybe, skip, an old verdict or
 *     none is skipped with the reason; --force <idx> attempts it anyway.
 *   - Published pay is not under the floor; --accept-low-pay <idx> is the
 *     batch's «Всё равно подать».
 *   - No earlier application looks like this role; --force <idx> again.
 * Everything else is reported as skipped with the reason.
 *
 * Result lines: `idx | company — title | RESULT | detail`. RESULT is one of
 * applied · missing-answers · no-form · needs-account · captcha · not-remote
 * · submit-failed · skipped.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) { flags[a.slice(2)] = next; i += 1; } else flags[a.slice(2)] = true;
  }
  return flags;
}

const flags = parseArgs(process.argv.slice(2));
if (!flags.fetched) {
  console.error("usage: apply-batch.mjs --fetched fetched.json [--only i,j] [--skip i,j] [--submit] [--force i,j] [--accept-low-pay i,j] [--out results.json] [--answers dir]");
  process.exit(1);
}
const rows = JSON.parse(readFileSync(flags.fetched, "utf8"));
const only = flags.only ? new Set(String(flags.only).split(",").map(Number)) : null;
const skip = flags.skip ? new Set(String(flags.skip).split(",").map(Number)) : new Set();
const indexes = (value) => new Set(typeof value === "string" ? value.split(",").map(Number) : []);
const force = indexes(flags.force);
const acceptLowPay = indexes(flags["accept-low-pay"]);
const submit = flags.submit === true;
if (!submit) console.log("dry run: forms are filled, nothing is sent (--submit sends)");

/** Why «Подать» would not send this row unasked, or null. */
function stop(row) {
  const v = row.verdict;
  if (!force.has(row.index)) {
    if (!v) return "no Claude verdict yet — wait for it on the dashboard, or --force";
    if (v.stale) return `Claude's verdict is from older criteria (${v.verdict}/${v.score}) — --force to send anyway`;
    if (v.verdict === "skip") return `Claude: skip/${v.score}${v.hideReason ? ` «${v.hideReason}»` : ""}`;
    if (v.verdict === "maybe") return `Claude: maybe/${v.score} — something to check by hand first; --force to send`;
    const earlier = (row.flags ?? []).find((flag) => /похоже на отклик/.test(flag));
    if (earlier) return `${earlier} — --force to apply again`;
  }
  if (row.belowSalaryFloor && !acceptLowPay.has(row.index)) {
    return `pay below the floor: ${row.boardSalary ?? "?"} — --accept-low-pay ${row.index} to send anyway`;
  }
  return null;
}

/** "uop" / "b2b" when every published range agrees, as src/apply-runner.ts contractOf. */
function contractOf(pay) {
  const contracts = new Set((pay ?? []).map((range) => range.contract));
  const only = contracts.size === 1 ? [...contracts][0] : null;
  return only === "uop" || only === "b2b" ? only : null;
}
const UNDRIVABLE = /^(portal|himalayas-account|himalayas|indeed|\?)$/;
const previous = flags.out && existsSync(flags.out) ? JSON.parse(readFileSync(flags.out, "utf8")) : [];
const results = [...previous];

for (const row of rows) {
  if (only && !only.has(row.index)) continue;
  if (skip.has(row.index)) continue;
  if (previous.some((r) => r.index === row.index && r.result === "applied")) continue;
  const head = `${String(row.index).padStart(3)} | ${row.company} — ${row.title}`;
  let skipReason = null;
  if (row.error) skipReason = `fetch error: ${row.error}`;
  else if (row.closed) skipReason = "posting closed";
  else if (UNDRIVABLE.test(row.applyVendor ?? "?")) skipReason = `needs an account (${row.applyVendor})`;
  else skipReason = stop(row);
  if (skipReason) {
    console.log(`${head} | skipped | ${skipReason}`);
    results.push({ index: row.index, result: "skipped", detail: skipReason });
    continue;
  }
  const applyUrl = row.applyVendor === "linkedin-easy-apply" ? row.applyUrl.replace(/#easy-apply$/, "") : row.applyUrl;
  const args = [
    join(here, "apply.mjs"),
    applyUrl,
    "--url", row.url,
    "--company", row.company ?? "?",
    "--title", row.title ?? "?",
    "--source", row.source ?? (row.vendor === "linkedin" ? "linkedin" : "manual"),
    "--cover", "auto",
    "--stack", (row.stack ?? []).join(","),
  ];
  if (row.location) args.push("--location", String(row.location));
  // As «Подать» passes them (src/apply-runner.ts): the contract the published
  // ranges agree on picks the gross UoP or the net B2B figure, the ranges let a
  // salary field ask for the posting's top, and a giant's Warsaw office must
  // not stop the run on LinkedIn's Hybrid tag.
  const contract = contractOf(row.pay) ?? (row.contract === "uop" || row.contract === "b2b" ? row.contract : null);
  if (contract) args.push("--contract", contract);
  if (row.pay?.length) args.push("--pay", JSON.stringify(row.pay));
  if (row.officeOk) args.push("--office-ok");
  // The board's own figure before one the regexes found in the text: those
  // picked up funding rounds and training budgets ($26, $781).
  const salary = row.boardSalary ?? row.salary?.[0];
  if (salary) args.push("--salary", String(salary));
  if (row.postedAt) args.push("--posted", String(row.postedAt));
  if (!submit) args.push("--dry-run");
  const answersFile = flags.answers ? join(flags.answers, `${row.index}.json`) : null;
  if (answersFile && existsSync(answersFile)) args.push("--answers", answersFile);

  const started = Date.now();
  // Greenhouse and LinkedIn run headed: apply.mjs may wait up to 5 minutes for
  // the person to type an e-mailed code, after filling the form. A 4-minute kill
  // closed the window under them mid-code.
  const headed = /greenhouse|linkedin/.test(`${row.applyVendor ?? ""} ${row.vendor ?? ""} ${applyUrl}`);
  const run = spawnSync(process.execPath, args, { encoding: "utf8", timeout: headed ? 480_000 : 240_000 });
  const stdout = run.stdout ?? "";
  let parsed = null;
  try { parsed = JSON.parse(stdout.slice(stdout.indexOf("{"))); } catch { parsed = null; }
  const result = parsed?.result ?? (run.error ? "timeout" : "crash");
  const detail =
    result === "applied" ? `${parsed.funnel} · ${parsed.filled.length} fields`
    : result === "missing-answers" ? parsed.missing.map((m) => `"${m.label.slice(0, 60)}"${m.options?.length ? ` [${m.options.slice(0, 5).join(" / ")}]` : ""}`).join("; ")
    : result === "dry-run" ? `${parsed.filled.length} fields filled`
    : result === "timeout" ? "killed before it answered — check the inbox for a receipt before re-running"
    : parsed?.reason ?? parsed?.errors?.join("; ") ?? (run.stderr ?? "").split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 200);
  console.log(`${head} | ${result} | ${detail} | ${Math.round((Date.now() - started) / 1000)}s`);
  results.push({ index: row.index, company: row.company, title: row.title, applyUrl, result, detail, screenshot: parsed?.screenshot ?? null, filled: parsed?.filled ?? null, missing: parsed?.missing ?? null });
  if (flags.out) writeFileSync(flags.out, JSON.stringify(results, null, 2));
}
