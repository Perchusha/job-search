/**
 * tests/verdict.mjs — the parts of src/verdict.ts that read Claude Code's own
 * words: when a usage limit resets, and which failures stop the whole queue.
 *
 * Run: npm run test:verdict (offline, instant). The texts are the ones Claude
 * Code 2.1.287 produces; if a new version words them differently, this is
 * where it shows.
 */

import assert from "node:assert/strict";

import { limitStop, resetTime } from "../src/verdict.ts";

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

console.log("\nVERDICT TESTS PASSED");
