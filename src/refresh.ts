/**
 * refresh.ts — keeps the postings table current, in the background.
 *
 * The dashboard used to ask every board when you clicked: ~4 s, ~80 s with
 * LinkedIn, and again after every restart. Now each board is fetched on its own
 * schedule into SQLite (src/db.ts postings) and a search reads that table in
 * milliseconds. Runs inside the dashboard (at start and every few minutes it
 * checks what is due), or alone as `npm run refresh` for Task Scheduler.
 *
 * Schedule, per board:
 *   - everything but LinkedIn: a full month-wide pass every REFRESH_HOURS (6 h
 *     by default; JOBHUNT_REFRESH_HOURS). A pass is ~2-5 s, and a full pass is
 *     what lets the store notice that a posting is gone.
 *   - LinkedIn: at most once a day, and only what is new since its last
 *     success (hoursOld), one query at a time. JobSpy sleeps 3-7 s between
 *     LinkedIn pages, so a month-wide pass costs ~80 s and ~140 requests from
 *     an IP LinkedIn rate-limits; a day's worth is a few requests per query.
 *     After an HTTP 429 it waits a day.
 *
 * Nothing here touches applications or dismissed: this is board data only.
 */

import {
  finishFetchRun,
  lastFetch,
  prunePostings,
  startFetchRun,
  upsertPostings,
} from "./db.ts";
import { fetchJobs, profileParams } from "./pipeline.ts";
import { OFFICE_OK, SEARCH_DEFAULTS, officeAcceptable } from "./profile.ts";
import { loadPreferences } from "./preferences.ts";
import type { SourceName } from "./sources.ts";

const HOUR = 3_600_000;

function refreshHours(): number {
  const configured = Number(process.env["JOBHUNT_REFRESH_HOURS"]);
  return Number.isFinite(configured) && configured > 0 ? configured : 6;
}

/** Fetched one query at a time, incrementally, at most daily. */
const SLOW_SOURCES: SourceName[] = ["linkedin"];
const SLOW_INTERVAL_HOURS = 24;
/** Fetched in full, but only daily: company boards and a monthly thread change slowly. */
const DAILY_SOURCES: SourceName[] = ["watchlist", "hackernews"];
const BACKOFF_HOURS = 24;

export type SourceOutcome = {
  source: SourceName;
  status: "fetched" | "fresh" | "backoff" | "running" | "failed" | "off";
  rows?: number;
  inserted?: number;
  error?: string;
};

function hoursSince(iso: string | null): number {
  return iso ? (Date.now() - Date.parse(iso)) / HOUR : Infinity;
}

/** Whether a board should be fetched now, and if not, why. */
function due(source: SourceName, force: boolean): SourceOutcome["status"] | "due" {
  const state = lastFetch(source);
  if (state.running) return "running";
  const slow = SLOW_SOURCES.includes(source);
  // The desktop app's "LinkedIn once a day" switch. Off: LinkedIn is not fetched
  // on any schedule, and its stored postings stay until they age out.
  if (slow && process.env["JOBHUNT_LINKEDIN_BACKGROUND"] === "0") return "off";
  // A pass cut short (recorded "partial, …: <error>") waits as long: retried
  // at the next 15-minute tick it would keep hitting a board that just refused.
  if (slow && state.lastError && /429|^partial/.test(state.lastError) && hoursSince(state.lastRunAt) < BACKOFF_HOURS) {
    return "backoff";
  }
  // "Refresh" refreshes the fast boards on demand; LinkedIn keeps its own
  // pace whatever is clicked, because every click used to cost ~140 requests.
  if (force && !slow) return "due";
  const interval = slow || DAILY_SOURCES.includes(source) ? SLOW_INTERVAL_HOURS : refreshHours();
  return hoursSince(state.lastSuccessAt) >= interval ? "due" : "fresh";
}

async function fetchSource(source: SourceName): Promise<SourceOutcome> {
  const slow = SLOW_SOURCES.includes(source);
  const state = lastFetch(source);
  // Incremental for the slow board: only what appeared since its last success
  // (plus a margin), never less than a day, never more than the profile window.
  const hoursOld = slow
    ? Math.min(SEARCH_DEFAULTS.hoursOld, Math.max(24, Math.ceil(hoursSince(state.lastSuccessAt)) + 2))
    : SEARCH_DEFAULTS.hoursOld;
  const run = startFetchRun(source, hoursOld);
  try {
    // The store gets Himalayas' worldwide pass too; a live search does not need it.
    const params = profileParams({ sources: [source], hoursOld, himalayasWorldwide: source === "himalayas" });
    let jobs;
    let skipped: string | null = null;
    if (slow) {
      // One query at a time: ten parallel LinkedIn sessions from one IP is
      // what gets it rate-limited.
      jobs = [];
      for (const query of params.queries ?? []) {
        const fetched = await fetchJobs({ ...params, queries: [query] });
        jobs.push(...fetched.jobs);
        skipped = skipped ?? fetched.reports.find((report) => report.skipped)?.skipped ?? null;
        if (skipped && /429/.test(skipped)) break;
      }
      // The giants' Warsaw offices (profile.ts OFFICE_OK), the one exception
      // to remote-only, asked for by name: the queries above are remote-only.
      if (!(skipped && /429/.test(skipped))) {
        const giants = await fetchJobs({
          ...params,
          queries: [OFFICE_OK.linkedin.query],
          location: OFFICE_OK.linkedin.location,
          remoteOnly: false,
        });
        jobs.push(...giants.jobs.filter((job) => officeAcceptable(job)));
        skipped = skipped ?? giants.reports.find((report) => report.skipped)?.skipped ?? null;
      }
    } else {
      const fetched = await fetchJobs(params);
      jobs = fetched.jobs;
      skipped = fetched.reports.find((report) => report.skipped)?.skipped ?? null;
    }
    // A board that failed outright returned nothing: record the failure and
    // keep what is stored. A partial answer (some queries failed) is still kept.
    if (skipped && jobs.length === 0) {
      finishFetchRun(run, 0, skipped);
      return { source, status: "failed", error: skipped };
    }
    const { inserted } = upsertPostings(source, jobs);
    // LinkedIn reads only what is new since its last success. A pass cut short
    // (HTTP 429) used to count as one, so the next pass started after the gap
    // and the postings in it were never read. Kept, but recorded as failed:
    // the next pass starts from the last complete one, after the 429 backoff.
    if (slow && skipped) {
      const error = `partial, ${jobs.length} rows kept: ${skipped}`;
      finishFetchRun(run, jobs.length, error);
      return { source, status: "failed", rows: jobs.length, inserted, error };
    }
    finishFetchRun(run, jobs.length, null);
    return { source, status: "fetched", rows: jobs.length, inserted };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    finishFetchRun(run, 0, message);
    return { source, status: "failed", error: message };
  }
}

let inFlight: Promise<SourceOutcome[]> | null = null;

/**
 * Fetches every board that is due. One run at a time per process; a second
 * call while one is running gets the same promise. Fast boards run in
 * parallel; the slow one runs alongside them, query by query.
 */
export function refreshDue(options: { force?: boolean; sources?: readonly SourceName[] } = {}): Promise<SourceOutcome[]> {
  if (inFlight) return inFlight;
  const sources = options.sources?.length ? options.sources : SEARCH_DEFAULTS.sources;
  inFlight = (async () => {
    const outcomes = await Promise.all(
      sources.map(async (source): Promise<SourceOutcome> => {
        const verdict = due(source, options.force ?? false);
        if (verdict !== "due") return { source, status: verdict };
        return fetchSource(source);
      }),
    );
    prunePostings(SLOW_SOURCES);
    return outcomes;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** True while a refresh started by this process is running. */
export function refreshing(): boolean {
  return inFlight !== null;
}

/** The running refresh, if any — so a first search can wait for the first fill. */
export function currentRefresh(): Promise<SourceOutcome[]> | null {
  return inFlight;
}

export function describe(outcome: SourceOutcome): string {
  switch (outcome.status) {
    case "fetched":
      return `${outcome.source}: ${outcome.rows} rows, ${outcome.inserted} new`;
    case "failed":
      return `${outcome.source}: FAILED — ${outcome.error}`;
    default:
      return `${outcome.source}: ${outcome.status}`;
  }
}

/* `npm run refresh [-- --force]` — one pass, for Task Scheduler or by hand. */
const invokedPath = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (invokedPath.endsWith("src/refresh.ts")) {
  loadPreferences();
  const force = process.argv.includes("--force");
  const outcomes = await refreshDue({ force });
  for (const outcome of outcomes) console.log(describe(outcome));
  process.exitCode = outcomes.some((outcome) => outcome.status === "failed") ? 1 : 0;
}
