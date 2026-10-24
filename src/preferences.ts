/**
 * preferences.ts — «Мои условия»: the candidate's terms that several layers
 * read, in one place, editable in Настройки.
 *
 * Each of these used to be written several times over in different forms: the
 * pay floor as a constant in profile.ts and as ten hand-converted numbers in
 * the criteria prose; the giants whose offices are fine as a regex in
 * profile.ts, a list in the criteria and a line in profile.json; the Polish
 * level as a regex in workmode.ts and a phrase in the criteria, the two
 * already disagreeing about B2. Adding the giants exception touched 13 files.
 * Now the code reads these values, and the criteria get them as a generated
 * paragraph (verdict.ts), so Claude and the rules cannot drift apart.
 *
 * Stored in DB meta `preferences`, like the Claude settings. The defaults are
 * what was hard-coded before. Processes that have a database load them at
 * start and after a save (the dashboard, the MCP server, `npm run refresh`);
 * anything else — the tests among them — works with the defaults and never
 * opens a database for them.
 *
 * Not here: the facts application forms are filled from (the asks, notice,
 * work permit) — those are .claude/skills/job-apply/profile.json.
 */

import { getMeta, setMeta } from "./db.ts";

export type PolishLevel = "A2" | "B1" | "B2" | "C1";

export type Preferences = {
  /** PLN net a month on B2B: under it published pay is "below the floor". */
  floorB2bPlnMonth: number;
  /** My UoP↔B2B equivalence: this much gross on UoP… */
  uopGross: number;
  /** …is worth this much on B2B. */
  uopEqualsB2b: number;
  /** Paid hours in a month, for hourly rates. */
  hoursPerMonth: number;
  /** Companies (subsidiaries named too) whose hybrid or office roles are fine… */
  officeCompanies: string[];
  /** …in these cities only. */
  officeCities: string[];
  /** My Polish: a required level above it is a stop. */
  polish: PolishLevel;
  /**
   * Screening rules switched off in Настройки → Правила, by id
   * (src/screening.ts SCREEN_RULES): they stop hiding cards. Not part of
   * Claude's criteria — the rules run before Claude, not inside it.
   */
  rulesOff: string[];
  /**
   * How many days a hide of mine teaches the screening ("same role hidden
   * earlier", a company blocked for hides); 0 is for good. "Не интересна
   * компания" is a choice, not evidence: it stays whatever this says.
   */
  memoryDays: number;
};

const KEY = "preferences";
const LEVELS: PolishLevel[] = ["A2", "B1", "B2", "C1"];

export function defaultPreferences(): Preferences {
  return {
    floorB2bPlnMonth: 25_000,
    uopGross: 34_000,
    uopEqualsB2b: 27_500,
    hoursPerMonth: 168,
    officeCompanies: [
      "Google", "Alphabet", "YouTube", "DeepMind", "Apple", "Netflix", "Meta", "Facebook", "Instagram",
      "WhatsApp", "Microsoft", "GitHub", "LinkedIn", "Amazon", "AWS", "NVIDIA",
    ],
    officeCities: ["Warszawa", "Warsaw"],
    polish: "B1",
    rulesOff: [],
    memoryDays: 0,
  };
}

let current: Preferences = defaultPreferences();
/** Bumped on every load and save, so caches built from the values know to go. */
let revision = 0;

export function preferences(): Preferences {
  return current;
}

export function preferencesRevision(): number {
  return revision;
}

function names(value: unknown): string[] | null {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;\n]/) : null;
  if (!list) return null;
  const clean = list.map((item) => String(item).trim()).filter((item) => item.length > 0 && item.length <= 60);
  return [...new Set(clean)].slice(0, 40);
}

/** Checks and fills in a stored or submitted object; throws on a value that cannot be right. */
function validated(input: Record<string, unknown>, base: Preferences): Preferences {
  const next = { ...base };
  const number = (key: keyof Preferences, min: number, max: number) => {
    if (!(key in input)) return;
    const value = Number(input[key]);
    if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${key} must be a number from ${min} to ${max}`);
    (next as Record<string, unknown>)[key] = value;
  };
  number("floorB2bPlnMonth", 1_000, 200_000);
  number("uopGross", 1_000, 200_000);
  number("uopEqualsB2b", 1_000, 200_000);
  number("hoursPerMonth", 100, 200);
  number("memoryDays", 0, 730);
  if ("officeCompanies" in input) {
    const list = names(input["officeCompanies"]);
    if (!list) throw new Error("officeCompanies must be a list of names");
    next.officeCompanies = list;
  }
  if ("officeCities" in input) {
    const list = names(input["officeCities"]);
    if (!list || list.length === 0) throw new Error("officeCities must name at least one city");
    next.officeCities = list;
  }
  if ("polish" in input) {
    if (!LEVELS.includes(input["polish"] as PolishLevel)) throw new Error(`polish must be one of: ${LEVELS.join(", ")}`);
    next.polish = input["polish"] as PolishLevel;
  }
  if ("rulesOff" in input) {
    // Which ids exist is screening.ts's to say (the server checks before saving); here only the shape.
    const list = input["rulesOff"];
    if (!Array.isArray(list) || !list.every((id) => typeof id === "string" && id.length > 0 && id.length <= 80)) {
      throw new Error("rulesOff must be a list of rule ids");
    }
    next.rulesOff = [...new Set(list as string[])];
  }
  return next;
}

/** Reads the stored terms into this process. A row that does not read is the defaults. */
export function loadPreferences(): Preferences {
  let saved: Record<string, unknown> = {};
  try {
    saved = JSON.parse(getMeta(KEY) ?? "{}") as Record<string, unknown>;
  } catch {
    // an unreadable row is the defaults
  }
  try {
    current = validated(saved, defaultPreferences());
  } catch {
    current = defaultPreferences();
  }
  revision++;
  return current;
}

/** Stores what Настройки sent; a value out of range is refused, nothing is stored then. */
export function savePreferences(input: Record<string, unknown>): Preferences {
  const next = validated(input, current);
  setMeta(KEY, JSON.stringify(next));
  current = next;
  revision++;
  return next;
}

/** The floor in the other units Claude and the forms meet, from the static FX rates. */
export function derivedFloors(fxToPln: Record<string, number>) {
  const p = current;
  const uopFloor = p.floorB2bPlnMonth * (p.uopGross / p.uopEqualsB2b);
  const per = (pln: number, currency: string) => pln / (fxToPln[currency] ?? 1);
  return {
    uopPlnMonth: uopFloor,
    b2b: {
      eurMonth: per(p.floorB2bPlnMonth, "EUR"),
      usdMonth: per(p.floorB2bPlnMonth, "USD"),
      eurYear: per(p.floorB2bPlnMonth * 12, "EUR"),
      usdYear: per(p.floorB2bPlnMonth * 12, "USD"),
      plnHour: p.floorB2bPlnMonth / p.hoursPerMonth,
      eurHour: per(p.floorB2bPlnMonth / p.hoursPerMonth, "EUR"),
      usdHour: per(p.floorB2bPlnMonth / p.hoursPerMonth, "USD"),
    },
    uop: { eurMonth: per(uopFloor, "EUR"), usdMonth: per(uopFloor, "USD") },
  };
}
