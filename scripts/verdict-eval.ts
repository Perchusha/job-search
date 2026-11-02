/**
 * verdict-eval.ts — check criteria against the postings whose right answer is
 * known, before an edit sends every shown card back to Claude.
 *
 *   npm run eval:verdicts                         the criteria file as it is, on the labels
 *   npm run eval:verdicts -- --criteria draft.md  a draft of src/verdict-criteria.md
 *   npm run eval:verdicts -- --set borderline     the current verdicts scored 20–70: what flips
 *   npm run eval:verdicts -- --limit 10           the first 10 rows only
 *
 * Labels and runs: src/verdict-eval.ts. Each run is saved under
 * ~/.job-hunt/eval/runs/. A run of the file as it is also shows in
 * Settings → Claude; a draft's does not. Nothing is stored as a verdict.
 * Needs the claude CLI logged in, as the verdicts do; runs as many `claude -p`
 * as there are rows, outside the daily cap.
 */

import { readFileSync } from "node:fs";

import { closeDb } from "../src/db.ts";
import { borderlineSet, goldenSet, runEval, type EvalSet } from "../src/verdict-eval.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const set: EvalSet = flag("set") === "borderline" ? "borderline" : "labels";
const draft = flag("criteria");
const limit = Number(flag("limit") ?? 0);

const all = set === "labels" ? goldenSet() : borderlineSet();
const rows = limit > 0 ? all.slice(0, limit) : all;
console.log(`${rows.length} postings (${set})${draft ? `, criteria from ${draft}` : ", the criteria file as it is"}`);

const { summary, rows: results } = await runEval(rows, {
  set,
  criteriaText: draft ? readFileSync(draft, "utf8") : undefined,
  onProgress: (done, total) => process.stderr.write(`\r${done}/${total}`),
});
process.stderr.write("\n");

for (const row of results) {
  const mark = row.error ? "ERR" : row.ok ? " ok" : " ≠ ";
  const got = row.got ? `${row.got}/${row.score}` : row.error ?? "";
  console.log(`${mark} | ${row.expected.padEnd(5)} → ${got.padEnd(9)} | ${row.company} — ${row.title} | ${row.note}`);
  if (!row.ok && row.summary) console.log(`      ${row.summary}`);
}
console.log(
  `\n${summary.ok}/${summary.n} as expected · skip / not skip ${summary.skipAgree}/${summary.n}` +
    (summary.errors ? ` · ${summary.errors} errors` : "") +
    (summary.stopped ? ` · stopped: ${summary.stopped}` : "") +
    ` · criteria ${summary.version} · $${summary.costUsd} at API prices · ${summary.seconds}s`,
);
closeDb();
