/**
 * tests/verdict.mjs — the parts of src/verdict.ts that read Claude Code's own
 * words: when a usage limit resets, and which failures stop the whole queue;
 * and what a discussion of a verdict is told about the candidate.
 *
 * Run: npm run test:verdict (offline, instant). The texts are the ones Claude
 * Code 2.1.287 produces; if a new version words them differently, this is
 * where it shows.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discussionBrief, limitStop, resetTime, verdictView } from "../src/verdict.ts";

const at = (iso) => new Date(iso);
const local = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi).getTime() + 60_000;

/* ---- when the limit resets ---- */
const evening = at("2026-10-23T18:00:00");
assert.equal(resetTime("You've hit your session limit · resets 11pm (Europe/Warsaw)", evening), local(2026, 9, 23, 23, 0));
assert.equal(resetTime("You've hit your session limit · resets 11:30pm", evening), local(2026, 9, 23, 23, 30));
// Already past today: it is tomorrow's.
assert.equal(resetTime("You've hit your session limit · resets 9am", evening), local(2026, 9, 24, 9, 0));
assert.equal(resetTime("You've hit your session limit · resets 12am", evening), local(2026, 9, 24, 0, 0));
assert.equal(resetTime("You've hit your weekly limit · resets Oct 27, 3pm (Europe/Warsaw)", evening), local(2026, 9, 27, 15, 0));
assert.equal(resetTime("You've hit your weekly limit · resets Jan 2 at 9am", evening), local(2027, 0, 2, 9, 0));
assert.equal(resetTime("You've hit your session limit", evening), null);
assert.equal(resetTime("resets 25:00", evening), null);
console.log("PASS  reset times: today, tomorrow, a date, next year, none");

/* ---- what stops the queue ---- */
const session = limitStop({ is_error: true, api_error_status: 429 }, "You've hit your session limit · resets 11pm (Europe/Warsaw)");
assert.ok(session && /^лимит Claude до \d\d:\d\d$/.test(session.message), "a session limit pauses the queue");
assert.ok(limitStop({ is_error: true }, "You're out of usage credits · resets Oct 27, 3pm"), "out of credits pauses it too");
assert.ok(limitStop({ is_error: true, api_error_status: 429 }, "API Error: 429"), "any 429 pauses it");
const transient = limitStop({ is_error: true, api_error_status: 429 }, "API Error: Server is temporarily limiting requests (not your usage limit)");
assert.ok(transient && transient.until - Date.now() <= 2 * 60_000 + 1000, "a transient 429 is a short pause");
assert.equal(limitStop({ is_error: true }, "Claude: something else went wrong"), null);
assert.equal(limitStop(null, "could not start claude: ENOENT"), null);
console.log("PASS  limits: session, credits, any 429 pause; a transient 429 is short; other errors do not");

/* ---- what a discussion knows: the profile, by its full path, not the repo-relative one in the criteria ---- */
const brief = await discussionBrief();
assert.match(brief, /[\\/]\.claude[\\/]skills[\\/]job-apply[\\/]profile\.json/, "the brief names the profile's full path");
assert.ok(/^[A-Za-z]:[\\/]|^\//.test(brief.match(/из (\S+profile\.json)/)?.[1] ?? ""), "an absolute one");
assert.ok(brief.includes('"plnMonthlyB2BRange"') && brief.includes('"workAuthorisation"'), "with the profile itself in it");
console.log("PASS  the discussion's CLAUDE.md carries the profile: salary, work permit, answers");
assert.ok(brief.includes("максимум 3–4 предложения") && brief.includes("человеческим языком"), "open answers: short, in a person's words");
console.log("PASS  and how a form's open answers are written: 3–4 sentences, plain words");

/* ---- and the CV, as text from the PDF; a one-page stand-in, not the real one, which keeps changing ---- */
function onePagePdf(line) {
  const content = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}
const dir = mkdtempSync(join(tmpdir(), "jobhunt-cv-"));
try {
  const cv = join(dir, "cv.pdf");
  writeFileSync(cv, onePagePdf("Built a Google Maps event explorer with marker clustering"));
  const withCv = await discussionBrief(cv);
  assert.ok(withCv.includes("```text\nBuilt a Google Maps event explorer with marker clustering\n```"), "the CV's text, fenced");
  assert.ok(withCv.includes(`текстом из ${cv}`), "and where it came from");
  const missing = await discussionBrief(join(dir, "gone.pdf"));
  assert.ok(missing.includes("Резюме не прочиталось") && !missing.includes("```text"), "a missing CV is said, not left out");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("PASS  and the CV: its text from the PDF, or a word that it could not be read");

/* ---- Настройки → «Не убирать, если единственная причина»: a policy over the stored verdict, no new run ---- */
const stored = (verdict, factors) => ({
  job_key: "k", url: "https://example.com/k", company: "Acme", title: "Frontend Engineer", verdict, score: 25,
  summary: "", session_id: null, model: "opus", criteria: "v1", requested: "auto", text_chars: 3000,
  evaluated_at: "2026-10-24T10:00:00Z",
  details: JSON.stringify({ dealbreakers: factors.map((factor) => ({ factor, text: `${factor} says no` })) }),
});
const formatOnly = verdictView(stored("skip", ["format"]), "v1", undefined, ["format", "level"]);
assert.equal(formatOnly.verdict, "maybe", "a skip on a softened kind shows in «Проверить»");
assert.deepEqual(formatOnly.softened, ["format"], "named by its kind");
assert.deepEqual(formatOnly.dealbreakers, ["format says no"], "the stop factor itself stays on the card");
assert.equal(verdictView(stored("skip", ["format", "stack"]), "v1", undefined, ["format"]).verdict, "skip", "one kind not softened keeps the skip");
assert.equal(verdictView(stored("skip", ["poland"]), "v1", undefined, ["format", "level", "stack", "role", "language"]).verdict, "skip", "Poland is never softened");
assert.equal(verdictView(stored("skip", ["format"]), "v1").softened, null, "nothing softened by default");
assert.equal(verdictView(stored("skip", []), "v1", undefined, ["format"]).verdict, "skip", "a skip with no typed stop factor stays");
const oldFormat = { ...stored("skip", []), details: JSON.stringify({ dealbreakers: ["remote only in the US"] }) };
assert.equal(verdictView(oldFormat, "v1", undefined, ["format"]).verdict, "skip", "an untyped stop factor (before FORMAT 3) stays");
assert.equal(verdictView(stored("apply", []), "v1", undefined, ["format"]).softened, null, "only skips are softened");
console.log("PASS  softened stop factors: a skip on softened kinds reads «Проверить», any other kind keeps it");

console.log("\nVERDICT TESTS PASSED");
