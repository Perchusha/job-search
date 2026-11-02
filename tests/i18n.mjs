/**
 * tests/i18n.mjs — the Russian catalog against the code: every English text the
 * code can show has its Russian, with the same {names}, and nothing is kept
 * that the code no longer says. English is the source text, so a text missing
 * from src/locale-ru.json would not fail anywhere else: it would just show
 * English in the Russian interface.
 *
 * Run: npm run test:i18n
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import { reasonWords, t, tn } from "../src/i18n.ts";
import { SCREEN_RULES } from "../src/screening.ts";

const SRC = new URL("../src/", import.meta.url);
const catalog = JSON.parse(readFileSync(new URL("locale-ru.json", SRC), "utf8"));
const unquoted = (text) => JSON.parse(`"${text}"`);

// What the code says: t("…") and tn(n, "…", "…"), in the page and on the server, and the page's {{…}}.
const single = new Set();
const plural = new Map();
const sources = ["dashboard.html", ...readdirSync(SRC).filter((file) => file.endsWith(".ts"))];
for (const file of sources) {
  const text = readFileSync(new URL(file, SRC), "utf8");
  if (file === "dashboard.html") for (const [, key] of text.matchAll(/\{\{(.+?)\}\}/g)) single.add(key);
  for (const [, key] of text.matchAll(/(?<![\w.])t\(\s*"((?:[^"\\]|\\.)*)"/g)) single.add(unquoted(key));
  for (const [, one, other] of text.matchAll(/(?<![\w.])tn\([^"]*?"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"/g)) {
    plural.set(unquoted(other), unquoted(one));
  }
}
// The rules' names and notes are kept in English where the rules are defined, and translated when served.
for (const rule of SCREEN_RULES) {
  single.add(rule.label);
  if (rule.note) single.add(rule.note);
}
assert.ok(single.size > 400, `the scan found only ${single.size} texts: is it still reading the code?`);

const missing = [...single, ...plural.keys()].filter((key) => !(key in catalog));
assert.deepEqual(missing, [], "texts with no Russian in src/locale-ru.json");
const unused = Object.keys(catalog).filter((key) => !single.has(key) && !plural.has(key));
assert.deepEqual(unused, [], "Russian kept for texts the code no longer says");
console.log(`PASS  the catalog holds every text the code says, and only those: ${single.size} + ${plural.size} plurals`);

const names = (text) => [...text.matchAll(/\{(\w+)\}/g)].map(([, name]) => name).sort().join();
for (const key of single) {
  assert.equal(typeof catalog[key], "string", `"${key}" takes one form`);
  assert.equal(names(catalog[key]), names(key), `"${key}" and its Russian fill in the same names`);
  assert.ok(/[Ѐ-ӿ]/.test(catalog[key]) || catalog[key] === key || !/[a-z]{3}/i.test(key) || /[A-Z0-9]{2}|\bsrc\//.test(catalog[key]),
    `"${key}" reads as Russian: "${catalog[key]}"`);
}
for (const [other, one] of plural) {
  const forms = catalog[other];
  assert.ok(Array.isArray(forms) && forms.length === 3, `"${other}" holds Russian's three plural forms`);
  for (const form of forms) assert.equal(names(form), names(other), `"${other}" and "${form}" fill in the same names`);
  assert.equal(names(one), names(other), `"${one}" and "${other}" fill in the same names`);
}
console.log("PASS  each has the same {names}, a plural its three forms");

// English here: this process has no database, so the default.
assert.equal(t("Save"), "Save");
assert.equal(t("Not saved: {error}", { error: "x" }), "Not saved: x");
assert.equal(tn(1, "{n} reply", "{n} replies"), "1 reply");
assert.equal(tn(5, "{n} reply", "{n} replies"), "5 replies");
assert.equal(t("a text the catalog has never seen"), "a text the catalog has never seen");
assert.ok(Object.keys(reasonWords()).includes("не remote") && reasonWords()["не remote"] === "not remote", "a hide reason is an id with a word for it");
console.log("PASS  English is the default, and the source text");
