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

const POLISH_REQUIRED =
  /\b(?:fluent|native|excellent|very good|advanced|proficient|business)\b[^.\n]{0,25}\bpolish\b|\bpolish\b[^.\n]{0,15}\b(?:c1|c2|native|fluent)\b|\b(?:biegł\w*|bardzo dobr\w*|dobr\w*)\s+(?:znajomość\s+)?język\w*\s+polski\w*|\bjęzyk\w* polski\w*[^.\n]{0,15}\b(?:c1|c2|biegł\w*|ojczysty)/i;

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
    polishRequired: POLISH_REQUIRED.test(text),
    inPolish: polishWords >= 6,
  };
  CACHE.set(job, signals);
  return signals;
}
