/**
 * i18n.ts — the app's two languages. English is the source text and the
 * default; src/locale-ru.json holds the Russian for each English text, so the
 * code reads in English and a text with no translation stays English
 * (tests/i18n.mjs checks that none is missing).
 *
 * t("Not saved: {error}", { error }) fills in the {names}. tn(n, "{n} reply",
 * "{n} replies") picks a plural: the catalog keeps three Russian forms under
 * the English plural (1 ответ, 2 ответа, 5 ответов).
 *
 * The language is one of the stored terms (src/preferences.ts): one for the
 * whole app, so the server's own words, the page and what Claude writes all
 * follow it. The page has the same two functions over the catalog the server
 * puts into it, and it reloads when the language changes.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { preferences, type Language } from "./preferences.ts";

type Entry = string | [string, string, string];

const RU = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "locale-ru.json"), "utf8")) as Record<string, Entry>;

export function language(): Language {
  return preferences().language;
}

/** What the page's own t() and tn() read: nothing to look up in English. */
export function catalog(): Record<string, Entry> {
  return language() === "ru" ? RU : {};
}

/** For dates and numbers. en-GB: 2 Nov and a 24-hour clock, what a reader in Europe expects. */
export function locale(): string {
  return language() === "ru" ? "ru" : "en-GB";
}

function fill(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

export function t(text: string, vars?: Record<string, string | number>): string {
  const found = language() === "ru" ? RU[text] : undefined;
  return fill(typeof found === "string" ? found : text, vars);
}

/** 1 ответ, 2 ответа, 5 ответов. */
function russianForm(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return forms[1];
  return forms[2];
}

export function tn(n: number, one: string, other: string, vars?: Record<string, string | number>): string {
  const found = language() === "ru" ? RU[other] : undefined;
  const text = Array.isArray(found) ? russianForm(n, found) : n === 1 ? one : other;
  return fill(text, { n, ...vars });
}

/** A quotation in the language's own marks. */
export function quote(text: string): string {
  return language() === "ru" ? `«${text}»` : `“${text}”`;
}

/**
 * The hide reasons are ids that happen to be Russian: the hides in the database,
 * Claude's verdict schema and the screening rules all hold these strings, so
 * they stay as they are in both languages. This is how each reads on screen.
 */
export function reasonWords(): Record<string, string> {
  return {
    "не remote": t("not remote"),
    "не тот стек": t("wrong stack"),
    "уровень (mid/junior)": t("level (mid/junior)"),
    "не интересна компания": t("company not of interest"),
    "зарплата ниже": t("pay too low"),
    "уже откликался в другом месте": t("already applied elsewhere"),
    "вакансия неактуальна": t("posting out of date"),
    "не из Польши": t("not from Poland"),
    "не та роль": t("wrong role"),
    "нужен другой язык": t("needs another language"),
    "вакансия закрыта": t("posting closed"),
  };
}

export function reasonWord(reason: string): string {
  return reasonWords()[reason] ?? reason;
}
