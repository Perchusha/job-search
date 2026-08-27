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

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Job } from "./sources.ts";

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

type RawJob = Record<string, unknown>;

function runScraper(options: JobSpyOptions): Promise<RawJob[]> {
  const python = resolvePython();
  if (python === null) {
    throw new JobSpyUnavailable(
      "no Python found — run `npm run setup:jobspy` (or set JOBHUNT_PYTHON)",
    );
  }
  if (!existsSync(SCRIPT_PATH)) {
    throw new JobSpyUnavailable(`bridge script missing at ${SCRIPT_PATH}`);
  }

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

  return new Promise<RawJob[]>((resolvePromise, rejectPromise) => {
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

    const finish = (error: Error | null, jobs: RawJob[] = []) => {
      clearTimeout(timer);
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // A leftover temp dir is not worth failing a search over.
      }
      if (error) rejectPromise(error);
      else resolvePromise(jobs);
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
        };
        if (payload.error) {
          finish(new Error(payload.error));
          return;
        }
        finish(null, payload.jobs ?? []);
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
    postedAt: posted && !Number.isNaN(posted.getTime()) ? posted.toISOString() : null,
    // JobSpy has no per-country eligibility metadata; the search is scoped by
    // `location` instead, and the scorer reads the location text.
    locationRestrictions: [],
    description: description ? description.slice(0, 8000) : null,
  };
}

/** Fetch and normalize. Throws on failure so the caller can record a skip. */
export async function fetchJobSpy(options: JobSpyOptions): Promise<Job[]> {
  const raw = await runScraper(options);
  return raw.map((entry) => normalize(entry)).filter((job): job is Job => job !== null);
}
