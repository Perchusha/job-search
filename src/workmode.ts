/**
 * workmode.ts — what a posting's own text says about where and in what
 * language the work happens.
 *
 * Board flags are not enough. Indeed's is_remote is set by a substring test for
 * "remote" anywhere in the body, so "Hybrid by design … 3 days office in
 * Kraków" is listed as remote and showed as "geo confirmed". Measured on one
 * pass: 8 of 18 such Indeed cards required office days in the text.
 *
 * Read per sentence, because the false alarms are all in the same sentence as
 * the alarm: "Hybrydowy lub 100% zdalnie", "remotely from anywhere … or
 * hybrid", "hybrid deployment models". These only label a card and demote it
 * within its band; nothing is hidden on the strength of a regex.
 */

import { preferences, type PolishLevel } from "./preferences.ts";

export type WorkSignals = {
  /** The text asks for office presence. */
  mode: "hybrid" | "onsite" | null;
  /** The sentence that said so, trimmed, for the card's tooltip. */
  context: string | null;
  /** Fluent/native Polish is required — above the B1 I have. */
  polishRequired: boolean;
  /** The posting itself is written in Polish. */
  inPolish: boolean;
};

const DAYS_A_WEEK =
  "(?:\\d|one|two|three|four|jeden|dwa|trzy|cztery)\\s*(?:\\(\\d\\)\\s*)?(?:days?|dni|dzień|razy)\\s*(?:a|per|in a|each|w|na)?\\s*(?:week|tydzień|tygodniu)";
const OFFICE = "(?:office|biur\\w*|on[- ]?site|stacjonarn\\w*)";
/** "2 days a week in the office" and "praca w biurze 3 dni w tygodniu". */
const OFFICE_DAYS = new RegExp(
  `\\b${DAYS_A_WEEK}[^.\\n]{0,40}${OFFICE}|${OFFICE}[^.\\n]{0,30}\\b${DAYS_A_WEEK}`,
  "i",
);
const HYBRID = /\bhybrid\b|\bhybryd\w*|\bpraca hybrydowa\b/i;
const ONSITE = /\b(?:on[- ]?site only|fully on[- ]?site|100% (?:on[- ]?site|stacjonarn\w*)|praca stacjonarna|w pełni stacjonarn\w*)\b/i;

/** Same-sentence wording that makes office presence optional or unrelated. */
const NOT_REQUIRED =
  /\b(?:or (?:fully )?remote(?:ly)?|remote(?:ly)? or|lub (?:w pełni |100% )?zdaln\w*|zdaln\w* lub|100% remote|fully remote(?!ly)|remote(?:ly)? from anywhere|opportunit\w* to work remotely|work remotely within|hybrid work opportunit\w*|optional|if you (?:want|prefer|like)|your choice|preferably|opcjonaln\w*|hybrid (?:cloud|deployment|app|apps|mobile|environment|infrastructure|architecture)|hybrid[- ]?(?:work )?model (?:for|of) (?:our )?(?:clients|customers))/i;

/*
 * Polish above my B1, as the criteria put it: B2, C1, C2, fluent, native,
 * "biegły", "płynny", "swobodnie". The first version missed B2 ("at least B2
 * Polish") and the other spellings ("fluency in Polish", "biegle posługujesz
 * się", "płynna znajomość języka polskiego"): Claude found 13 such
 * requirements in the texts it read, the regex 3. A sentence that makes it a
 * plus is not a requirement.
 */
function polishPattern(levels: string, good: string): RegExp {
  return new RegExp(
    [
      "\\b(?:fluent|fluency|native|excellent|very good|advanced|proficient|business)\\b[^.\\n]{0,25}\\bpolish\\b",
      `\\bpolish\\b[^.\\n]{0,20}\\b(?:${levels}|native|fluent|fluency)\\b`,
      `\\b(?:${levels})\\b\\+?[^.\\n]{0,15}\\bpolish\\b`,
      `(?:biegł|bardzo dobr|${good}płynn)\\S*\\s+(?:znajomoś\\S*\\s+)?(?:język\\S*\\s+)?polski`,
      "\\bbiegle\\b[^.\\n]{0,40}polsk",
      "swobodn\\S*[^.\\n]{0,40}(?:po polsku|język\\S* polski)",
      `język\\S* polski\\S*[^.\\n]{0,15}\\b(?:${levels}|biegł\\S*|ojczysty)`,
      `\\bpolski\\s*[(:–-]\\s*(?:${levels})\\b`,
    ].join("|"),
    "i",
  );
}

/** By my level in «Мои условия» (src/preferences.ts): what counts as "above it". */
const POLISH_ABOVE: Record<PolishLevel, RegExp | null> = {
  A2: polishPattern("b1|b2|c1|c2", "dobr|"),
  B1: polishPattern("b2|c1|c2", "dobr|"),
  // "dobra znajomość" is about B2: no stop for someone who has it.
  B2: polishPattern("c1|c2", ""),
  C1: null,
};
/** Said as a plus, not a requirement: then it is not a stop. */
const AS_A_PLUS = /nice to have|is a plus|a plus\b|advantage|asset|preferred|bonus|mile widzian|atutem|dodatkow/i;

function polishRequired(text: string): boolean {
  const pattern = POLISH_ABOVE[preferences().polish];
  return pattern !== null && sentences(text).some((sentence) => pattern.test(sentence) && !AS_A_PLUS.test(sentence));
}

const POLISH_WORDS =
  /\b(?:oraz|jest|będzie|pracy|wymagania|doświadczenie|znajomość|oferujemy|obowiązki|zakres|projektów|zespole|aplikacji|współpracy|mile widziane)\b/gi;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter((part) => part.length > 0);
}

function clip(sentence: string): string {
  const clean = sentence.replace(/\\(.)/g, "$1").replace(/[*_#>`]+/g, "").replace(/\s+/g, " ").trim();
  return clean.length > 160 ? `${clean.slice(0, 157)}…` : clean;
}

const CACHE = new WeakMap<object, WorkSignals>();

/** Signals from the posting text. Cached per job object; returns nulls when there is no text. */
export function workSignals(job: { description?: string | null }): WorkSignals {
  const cached = CACHE.get(job);
  if (cached) return cached;

  // Indeed bodies arrive as Markdown: "**100% zdalnie**", "front\-end".
  const text = (job.description ?? "").replace(/\\(.)/g, "$1").replace(/\*\*|__/g, "");
  let mode: WorkSignals["mode"] = null;
  let context: string | null = null;
  for (const sentence of sentences(text)) {
    const onsite = ONSITE.test(sentence);
    const hybrid = HYBRID.test(sentence) || OFFICE_DAYS.test(sentence);
    if (!onsite && !hybrid) continue;
    if (NOT_REQUIRED.test(sentence)) continue;
    mode = onsite ? "onsite" : "hybrid";
    context = clip(sentence);
    break;
  }

  const polishWords = text.match(POLISH_WORDS)?.length ?? 0;
  const signals: WorkSignals = {
    mode,
    context,
    polishRequired: polishRequired(text),
    inPolish: polishWords >= 6,
  };
  CACHE.set(job, signals);
  return signals;
}
