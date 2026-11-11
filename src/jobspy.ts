/**
 * jobspy.ts — adapter for the JobSpy scraper (LinkedIn, Indeed, Glassdoor, ...).
 *
 * JobSpy is Python, so this shells out to scripts/jobspy_fetch.py and reads the
 * JSON file it writes. Two deliberate choices:
 *
 *   1. Results come back through a FILE, not stdout. JobSpy and its HTTP stack
 *      log to the console; a stray log line would corrupt a stdout JSON stream.
 *   2. UTF-8 is forced on the child process. Polish listings are full of ł/ę/ó
 *      and the Windows console default (cp1252) throws UnicodeEncodeError.
 *
 * This source is OPTIONAL. If the interpreter or the package is missing, it
 * reports itself as skipped and the free feeds carry the search — `npm install`
 * alone still gives a working tool.
 */

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { Job, PayRange } from "./sources.ts";

/** JobSpy boards we expose. Their ids match JobSpy's `site_name` values. */
export const JOBSPY_SITES = ["indeed", "linkedin", "glassdoor", "google", "zip_recruiter"] as const;
export type JobSpySite = (typeof JOBSPY_SITES)[number];

export type JobSpyOptions = {
  sites?: JobSpySite[];
  query?: string;
  /** Free-text location handed to JobSpy, e.g. "Poland", "European Union". */
  location?: string;
  isRemote?: boolean;
  resultsWanted?: number;
  /** Only postings newer than this many hours. Default 14 days. */
  hoursOld?: number;
  /** Indeed needs the country separately from `location`. */
  countryIndeed?: string;
  jobType?: string;
  /** LinkedIn omits descriptions unless asked — costs one request per job. */
  linkedinFetchDescription?: boolean;
  proxies?: string[];
};

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(PROJECT_ROOT, "scripts", "jobspy_fetch.py");
const DEFAULT_TIMEOUT_MS = 180_000;

export class JobSpyUnavailable extends Error {}

/**
 * The scraper stopped part-way — LinkedIn's HTTP 429, or the bridge's time
 * budget — and returned what it had read. A failure that still carries rows:
 * the caller keeps them and records the run as failed, so an incremental
 * board's next pass starts from its last complete one.
 */
export class PartialFetch extends Error {
  constructor(
    message: string,
    readonly jobs: Job[],
  ) {
    super(message);
  }
}

/**
 * Indeed is country-scoped: it searches a national domain (pl.indeed.com), so
 * `country_indeed` has to agree with the location or it returns zero results.
 * LinkedIn has no such constraint and happily takes "European Union".
 *
 * This maps a location string onto JobSpy's country name when it can, so
 * `location: "Berlin, Germany"` searches de.indeed.com instead of silently
 * finding nothing on the Polish one.
 */
const COUNTRY_HINTS: Array<[pattern: RegExp, country: string]> = [
  [/\b(poland|polska|warsaw|warszawa|krak[oó]w|wroc[lł]aw|gda[nń]sk|pozna[nń]|pl)\b/i, "poland"],
  [/\b(germany|deutschland|berlin|munich|m[uü]nchen|hamburg|de)\b/i, "germany"],
  [/\b(netherlands|holland|amsterdam|nl)\b/i, "netherlands"],
  [/\b(spain|espa[nñ]a|madrid|barcelona|es)\b/i, "spain"],
  [/\b(portugal|lisbon|lisboa|porto)\b/i, "portugal"],
  [/\b(france|paris|fr)\b/i, "france"],
  [/\b(ireland|dublin|ie)\b/i, "ireland"],
  [/\b(united kingdom|uk|england|london)\b/i, "uk"],
  [/\b(czech|czechia|prague|praha)\b/i, "czech republic"],
  [/\b(sweden|stockholm)\b/i, "sweden"],
  [/\b(switzerland|zurich|z[uü]rich)\b/i, "switzerland"],
  [/\b(austria|vienna|wien)\b/i, "austria"],
  [/\b(italy|italia|milan|rome|roma)\b/i, "italy"],
  [/\b(united states|usa|us)\b/i, "usa"],
  [/\b(canada|toronto|vancouver)\b/i, "canada"],
];

export function deriveCountryIndeed(location: string | undefined): string {
  const text = (location ?? "").trim();
  if (text.length === 0) return "poland";
  for (const [pattern, country] of COUNTRY_HINTS) {
    if (pattern.test(text)) return country;
  }
  // Unknown or supranational ("European Union", "EMEA"): Indeed cannot scope to
  // it. Stay on Poland — the caller's own country — rather than guessing.
  return "poland";
}

/**
 * Prefers the project venv, so the scraper works without touching the user's
 * global Python. JOBHUNT_PYTHON overrides everything.
 */
export function resolvePython(): string | null {
  const fromEnv = process.env["JOBHUNT_PYTHON"];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();

  const candidates = [
    join(PROJECT_ROOT, ".venv", "Scripts", "python.exe"), // Windows
    join(PROJECT_ROOT, ".venv", "bin", "python"), // macOS / Linux
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** True when the scraper can actually run — used to decide whether to offer it. */
export function isJobSpyAvailable(): boolean {
  return resolvePython() !== null && existsSync(SCRIPT_PATH);
}

/*
 * A venv belongs to the Python it was made from: .venv/pyvenv.cfg names that
 * interpreter's folder (`home`). When it goes, .venv/Scripts/python.exe is
 * still there but only answers "No Python at …". On 2026-11-09 pyenv-win left
 * this PC, and LinkedIn and Indeed failed every 15 minutes for two days as
 * "scraper produced no output", seen only in the log. So before a scrape the
 * venv's Python is checked, and a venv whose Python is gone is moved onto
 * another one of the same minor version (`python -m venv --upgrade`): the
 * packages in it are built for that version, so nothing is downloaded.
 */
export type VenvState = { home: string; version: string; ok: boolean };

/** What .venv/pyvenv.cfg says beside this venv interpreter, and whether its Python is still there. */
export function venvState(venvPython: string): VenvState | null {
  const cfg = join(dirname(dirname(venvPython)), "pyvenv.cfg");
  if (!existsSync(cfg)) return null;
  const fields = new Map<string, string>();
  for (const line of readFileSync(cfg, "utf8").split(/\r?\n/)) {
    const at = line.indexOf("=");
    if (at > 0) fields.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  const home = fields.get("home");
  const version = fields.get("version") ?? fields.get("version_info");
  if (!home || !version) return null;
  const ok = ["python.exe", "python3", "python"].some((name) => existsSync(join(home, name)));
  return { home, version, ok };
}

const run = promisify(execFile);
const REPAIR_EVERY_MS = 10 * 60_000;
let lastRepair: { at: number; error: string | null } | null = null;
let repairing: Promise<void> | null = null;

/** "3.11" of "3.11.8". */
const minorOf = (version: string) => version.split(".").slice(0, 2).join(".");

/** Interpreters that might be installed, the Windows launcher's pick first. */
function pythonCandidates(minor: string, venvDir: string): Array<[file: string, args: string[]]> {
  const found: Array<[string, string[]]> = [];
  if (process.platform === "win32") found.push(["py", [`-${minor}`]]);
  const names = process.platform === "win32" ? ["python.exe"] : [`python${minor}`, "python3", "python"];
  const same = (path: string) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    // The Store's python.exe is a stub that opens the Store; the venv is the broken one.
    if (!dir || /WindowsApps/i.test(dir) || same(dir).startsWith(same(venvDir))) continue;
    for (const name of names) if (existsSync(join(dir, name))) found.push([join(dir, name), []]);
  }
  if (process.platform === "win32") {
    const folder = `Python${minor.replace(".", "")}`;
    for (const root of [join(process.env["LOCALAPPDATA"] ?? "", "Programs", "Python"), process.env["ProgramFiles"] ?? ""]) {
      if (root && existsSync(join(root, folder, "python.exe"))) found.push([join(root, folder, "python.exe"), []]);
    }
  }
  return found;
}

/** The first installed Python of this minor version, as its own executable path. */
async function findPython(minor: string, venvDir: string): Promise<string | null> {
  const probe = "import sys; print('%d.%d' % sys.version_info[:2]); print(sys.executable)";
  for (const [file, args] of pythonCandidates(minor, venvDir)) {
    try {
      const { stdout } = await run(file, [...args, "-c", probe], { timeout: 15_000, windowsHide: true });
      const [version, executable] = stdout.trim().split(/\r?\n/);
      if (version === minor && executable) return executable.trim();
    } catch {
      // not installed, or not a working interpreter: the next one
    }
  }
  return null;
}

async function repairVenv(python: string, state: VenvState): Promise<void> {
  const venvDir = dirname(dirname(python));
  const minor = minorOf(state.version);
  const base = await findPython(minor, venvDir);
  if (!base) {
    throw new JobSpyUnavailable(
      `the Python .venv was made from is gone (${state.home}), and no other Python ${minor} is installed — `
        + `install Python ${minor}, or run \`npm run setup:jobspy\``,
    );
  }
  console.error(`.venv: its Python (${state.home}) is gone; moving it onto ${base}`);
  await run(base, ["-m", "venv", "--upgrade", venvDir], { timeout: 120_000, windowsHide: true });
  try {
    await run(python, ["-c", "import jobspy"], { timeout: 60_000, windowsHide: true });
  } catch (error) {
    throw new JobSpyUnavailable(`.venv moved onto ${base}, but JobSpy does not load in it — run \`npm run setup:jobspy\` (${(error as Error).message.split("\n")[0]})`);
  }
  console.error(`.venv: repaired on ${base}`);
}

/**
 * The interpreter to scrape with, its venv repaired first if its Python is
 * gone. One repair at a time (LinkedIn and Indeed scrape side by side), and a
 * failed one is not retried for 10 minutes: the refresh asks every 15.
 */
async function scraperPython(): Promise<string> {
  const python = resolvePython();
  if (python === null) {
    throw new JobSpyUnavailable("no Python found — run `npm run setup:jobspy` (or set JOBHUNT_PYTHON)");
  }
  if (!existsSync(SCRIPT_PATH)) {
    throw new JobSpyUnavailable(`bridge script missing at ${SCRIPT_PATH}`);
  }
  // An interpreter named by hand is the user's own: used as it is.
  if (process.env["JOBHUNT_PYTHON"]?.trim()) return python;
  const state = venvState(python);
  if (state === null || state.ok) return python;
  if (!repairing) {
    if (lastRepair?.error && Date.now() - lastRepair.at < REPAIR_EVERY_MS) throw new JobSpyUnavailable(lastRepair.error);
    repairing = repairVenv(python, state)
      .then(() => {
        lastRepair = { at: Date.now(), error: null };
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        lastRepair = { at: Date.now(), error: message };
        console.error(`.venv: repair failed: ${message}`);
        throw new JobSpyUnavailable(message);
      })
      .finally(() => {
        repairing = null;
      });
  }
  await repairing;
  return python;
}

type RawJob = Record<string, unknown>;

async function runScraper(options: JobSpyOptions): Promise<{ jobs: RawJob[]; partial: string | null }> {
  const python = await scraperPython();

  const workDir = mkdtempSync(join(tmpdir(), "jobhunt-"));
  const outPath = join(workDir, `${randomUUID()}.json`);

  const config = {
    sites: options.sites ?? ["indeed"],
    query: options.query ?? "",
    location: options.location ?? "Poland",
    isRemote: options.isRemote ?? false,
    resultsWanted: options.resultsWanted ?? 50,
    hoursOld: options.hoursOld ?? 336,
    countryIndeed: options.countryIndeed ?? deriveCountryIndeed(options.location),
    jobType: options.jobType,
    linkedinFetchDescription: options.linkedinFetchDescription ?? false,
    proxies: options.proxies,
  };

  return new Promise<{ jobs: RawJob[]; partial: string | null }>((resolvePromise, rejectPromise) => {
    const child = spawn(python, [SCRIPT_PATH, outPath], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        // Non-negotiable: without these, Polish characters crash the child.
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
      stdio: ["pipe", "ignore", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`));
    }, DEFAULT_TIMEOUT_MS);

    const finish = (error: Error | null, jobs: RawJob[] = [], partial: string | null = null) => {
      clearTimeout(timer);
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // A leftover temp dir is not worth failing a search over.
      }
      if (error) rejectPromise(error);
      else resolvePromise({ jobs, partial });
    };

    child.on("error", (error) => {
      finish(new JobSpyUnavailable(`could not start Python: ${error.message}`));
    });

    child.on("close", (code) => {
      if (!existsSync(outPath)) {
        const detail = stderr.trim().split("\n").slice(-1)[0] ?? `exit ${code}`;
        finish(new Error(`scraper produced no output (${detail})`));
        return;
      }
      try {
        const payload = JSON.parse(readFileSync(outPath, "utf8")) as {
          jobs?: RawJob[];
          error?: string;
          partial?: string | null;
        };
        if (payload.error) {
          finish(new Error(payload.error));
          return;
        }
        finish(null, payload.jobs ?? [], payload.partial ?? null);
      } catch (error) {
        finish(new Error(`unreadable scraper output: ${(error as Error).message}`));
      }
    });

    child.stdin?.end(JSON.stringify(config), "utf8");
  });
}

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

/** JobSpy pay intervals -> multiplier to reach an annual figure. */
const ANNUALIZE: Record<string, number> = {
  hourly: 2080,
  daily: 260,
  weekly: 52,
  biweekly: 26,
  monthly: 12,
  yearly: 1,
  annual: 1,
};

function text(value: unknown): string | null {
  if (typeof value !== "string") return typeof value === "number" ? String(value) : null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function compact(amount: number): string {
  if (Math.abs(amount) >= 1000) {
    const thousands = amount / 1000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`;
  }
  return String(Math.round(amount));
}

/** JobSpy's posted pay as a PayRange; weekly figures become monthly. */
function payRange(
  min: number | null,
  max: number | null,
  currency: string | null,
  interval: string,
): PayRange[] {
  const low = min !== null && min > 0 ? min : null;
  const high = max !== null && max > 0 ? max : null;
  if (!currency || (low === null && high === null)) return [];
  const weekly = interval === "weekly" || interval === "biweekly";
  const scale = interval === "weekly" ? 52 / 12 : interval === "biweekly" ? 26 / 12 : 1;
  const unit: PayRange["unit"] =
    interval === "hourly" ? "hour" : interval === "daily" ? "day" : interval === "monthly" || weekly ? "month" : "year";
  return [{
    contract: "other",
    min: low === null ? null : low * scale,
    max: high === null ? null : high * scale,
    currency,
    unit,
    gross: false,
  }];
}

/** Maps a JobSpy `site` value onto our source ids. */
function mapSite(site: string | null): JobSpySite {
  const normalized = (site ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  return (JOBSPY_SITES as readonly string[]).includes(normalized)
    ? (normalized as JobSpySite)
    : "indeed";
}

function normalize(raw: RawJob): Job | null {
  const title = text(raw["title"]);
  const company = text(raw["company"]);
  // job_url_direct points at the employer's own posting when JobSpy resolved it.
  const url = text(raw["job_url_direct"]) ?? text(raw["job_url"]);
  if (!title || !company || !url) return null;

  const interval = (text(raw["interval"]) ?? "").toLowerCase();
  const factor = ANNUALIZE[interval] ?? 1;
  const rawMin = num(raw["min_amount"]);
  const rawMax = num(raw["max_amount"]);
  const currency = text(raw["currency"]);

  // Annualized so minSalary comparisons are apples-to-apples across sources,
  // while the display string keeps the period the posting actually stated.
  const salaryMin = rawMin !== null && rawMin > 0 ? rawMin * factor : null;
  const salaryMax = rawMax !== null && rawMax > 0 ? rawMax * factor : null;

  let salary: string | null = null;
  if (rawMin || rawMax) {
    const low = rawMin && rawMin > 0 ? rawMin : null;
    const high = rawMax && rawMax > 0 ? rawMax : null;
    const range =
      low !== null && high !== null && low !== high
        ? `${compact(low)}–${compact(high)}`
        : compact((low ?? high) as number);
    salary = [currency, range, interval ? `/ ${interval}` : null]
      .filter((part): part is string => Boolean(part))
      .join(" ");
  }

  const jobType = text(raw["job_type"]);
  const tags: string[] = [mapSite(text(raw["site"]))];
  if (jobType) tags.push(...jobType.split(/[,\s]+/).filter((entry) => entry.length > 0));
  if (raw["is_remote"] === true) tags.push("remote");

  const postedRaw = text(raw["date_posted"]);
  const posted = postedRaw ? new Date(postedRaw) : null;

  const description = text(raw["description"]);

  return {
    source: mapSite(text(raw["site"])),
    externalId: text(raw["id"]) ?? url,
    title,
    company,
    url,
    location: text(raw["location"]),
    remote: raw["is_remote"] === true,
    salary,
    salaryMin,
    salaryMax,
    tags: [...new Set(tags)],
    // The posted figures as a pay range, for the salary floor and minSalary.
    pay: payRange(rawMin, rawMax, currency, interval),
    postedAt: posted && !Number.isNaN(posted.getTime()) ? posted.toISOString() : null,
    // JobSpy has no per-country eligibility metadata; the search is scoped by
    // `location` instead, and the scorer reads the location text.
    locationRestrictions: [],
    description: description ? description.slice(0, 8000) : null,
  };
}

/** Fetch and normalize. Throws on failure so the caller can record a skip. */
export async function fetchJobSpy(options: JobSpyOptions): Promise<Job[]> {
  const { jobs: raw, partial } = await runScraper(options);
  const jobs = raw.map((entry) => normalize(entry)).filter((job): job is Job => job !== null);
  if (partial) throw jobs.length > 0 ? new PartialFetch(partial, jobs) : new Error(partial);
  return jobs;
}
