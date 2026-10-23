#!/usr/bin/env node
/**
 * apply-batch.mjs — run apply.mjs over a list of fetched postings, one line
 * of output per job, results saved as JSON. The model reads the lines, not
 * the forms.
 *
 *   node scripts/apply-batch.mjs --fetched <fetched.json> [--only 2,10,19] [--skip 5] [--dry-run] [--out results.json]
 *
 * A row is attempted when it has no `error`, is not `closed`, and its
 * applyVendor is one apply.mjs can drive (not portal / himalayas-account /
 * indeed). Everything else is reported as skipped with the reason.
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
  console.error("usage: apply-batch.mjs --fetched fetched.json [--only i,j] [--skip i,j] [--dry-run] [--out results.json] [--answers dir]");
  process.exit(1);
}
const rows = JSON.parse(readFileSync(flags.fetched, "utf8"));
const only = flags.only ? new Set(String(flags.only).split(",").map(Number)) : null;
const skip = flags.skip ? new Set(String(flags.skip).split(",").map(Number)) : new Set();
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
  if (row.salary?.[0]) args.push("--salary", String(row.salary[0]));
  if (flags["dry-run"]) args.push("--dry-run");
  const answersFile = flags.answers ? join(flags.answers, `${row.index}.json`) : null;
  if (answersFile && existsSync(answersFile)) args.push("--answers", answersFile);

  const started = Date.now();
  const run = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 240_000 });
  const stdout = run.stdout ?? "";
  let parsed = null;
  try { parsed = JSON.parse(stdout.slice(stdout.indexOf("{"))); } catch { parsed = null; }
  const result = parsed?.result ?? (run.error ? "timeout" : "crash");
  const detail =
    result === "applied" ? `${parsed.funnel} · ${parsed.filled.length} fields`
    : result === "missing-answers" ? parsed.missing.map((m) => `"${m.label.slice(0, 60)}"${m.options?.length ? ` [${m.options.slice(0, 5).join(" / ")}]` : ""}`).join("; ")
    : result === "dry-run" ? `${parsed.filled.length} fields filled`
    : parsed?.reason ?? parsed?.errors?.join("; ") ?? (run.stderr ?? "").split("\n").filter(Boolean).slice(-2).join(" ").slice(0, 200);
  console.log(`${head} | ${result} | ${detail} | ${Math.round((Date.now() - started) / 1000)}s`);
  results.push({ index: row.index, company: row.company, title: row.title, applyUrl, result, detail, screenshot: parsed?.screenshot ?? null, filled: parsed?.filled ?? null, missing: parsed?.missing ?? null });
  if (flags.out) writeFileSync(flags.out, JSON.stringify(results, null, 2));
}
