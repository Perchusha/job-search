/**
 * db.ts — SQLite open + schema + every data-access function.
 *
 * This is the only file that knows about better-sqlite3. To make the tracker
 * reachable from other devices later, swap the bodies below for a
 * Supabase/Postgres client and keep these signatures — nothing else changes.
 *
 * WAL mode is on so the MCP process and the dashboard process can read/write
 * the same file at the same time.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/**
 * Full vocabulary, including the derived-only `ghosted`.
 *
 * Lifecycle: `saved` -> `applied` -> `responded` -> `screening` -> `interview`
 * -> `offer` / `rejected`, with `ghosted` derived from a stale `applied`.
 *
 * `saved` is PRE-APPLICATION: "found it, haven't applied yet". It is the status
 * jobs added from search get, and it is excluded from the response-rate and
 * ghost-rate denominators in getStats — a job you never applied to cannot have
 * ghosted you.
 */
export const STATUSES = [
  "saved",
  "applied",
  "responded",
  "screening",
  "interview",
  "offer",
  "rejected",
  "ghosted",
] as const;

export type Status = (typeof STATUSES)[number];

/** Statuses that mean "they got back to me" — used for the response rate. */
const RESPONDED_STATUSES: Status[] = [
  "responded",
  "screening",
  "interview",
  "offer",
  "rejected",
];

export type ApplicationRow = {
  id: number;
  company: string;
  title: string;
  url: string | null;
  source: string | null;
  location: string | null;
  salary: string | null;
  status: string;
  applied_at: string;
  response_at: string | null;
  last_update: string;
  notes: string | null;
};

/** A row as presented to callers, with `ghosted` derived and days computed. */
export type Application = ApplicationRow & {
  /** Effective status: `ghosted` substituted for stale, unanswered applications. */
  status: Status;
  storedStatus: string;
  ghosted: boolean;
  daysSinceApplied: number;
  daysToResponse: number | null;
};

export type Stats = {
  total: number;
  /** Rows that represent a real application (everything except `saved`). */
  totalApplied: number;
  funnel: Record<Status, number>;
  responded: number;
  responseRate: number; // 0..1 of totalApplied
  ghostRate: number; // 0..1 of totalApplied
  avgDaysToResponse: number | null;
  staleDays: number;
};

export const DEFAULT_STALE_DAYS = 21;

/* ------------------------------------------------------------------ */
/* Connection                                                          */
/* ------------------------------------------------------------------ */

export function resolveDbPath(): string {
  const fromEnv = process.env["JOBHUNT_DB"];
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
  return join(homedir(), ".job-hunt", "jobs.db");
}

let db: Database.Database | null = null;

/** Opens (and on first call creates) the database. Safe to call repeatedly. */
export function getDb(): Database.Database {
  if (db) return db;

  const path = resolveDbPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = new Database(path);
  // WAL lets the dashboard read while the MCP server writes.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Wait rather than throw if the other process holds a write lock.
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function migrate(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS applications (
      id          INTEGER PRIMARY KEY,
      company     TEXT NOT NULL,
      title       TEXT NOT NULL,
      url         TEXT UNIQUE,
      source      TEXT,
      location    TEXT,
      salary      TEXT,
      status      TEXT NOT NULL DEFAULT 'applied',
      applied_at  TEXT NOT NULL,
      response_at TEXT,
      last_update TEXT NOT NULL,
      notes       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
    CREATE INDEX IF NOT EXISTS idx_applications_applied_at ON applications(applied_at);
  `);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function nowIso(): string {
  return new Date().toISOString();
}

function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.floor((to - from) / 86_400_000);
}

function hasResponded(row: ApplicationRow): boolean {
  return row.response_at !== null || RESPONDED_STATUSES.includes(row.status as Status);
}

/**
 * Applies the derived `ghosted` rule: an application still sitting at
 * `applied`, with no reply, older than `staleDays`, is presented as ghosted.
 * Nothing is written back to the database.
 */
function decorate(row: ApplicationRow, staleDays: number): Application {
  const daysSinceApplied = daysBetween(row.applied_at, nowIso());
  const ghosted =
    row.status === "applied" && row.response_at === null && daysSinceApplied > staleDays;

  return {
    ...row,
    status: (ghosted ? "ghosted" : row.status) as Status,
    storedStatus: row.status,
    ghosted,
    daysSinceApplied,
    // Clamped: a manually supplied response_at can predate applied_at, and a
    // negative "days to response" would poison the average in getStats.
    daysToResponse: row.response_at
      ? Math.max(0, daysBetween(row.applied_at, row.response_at))
      : null,
  };
}

/* ------------------------------------------------------------------ */
/* Data access                                                         */
/* ------------------------------------------------------------------ */

export type NewApplication = {
  company: string;
  title: string;
  url?: string | null;
  source?: string | null;
  location?: string | null;
  salary?: string | null;
  status?: Status;
  notes?: string | null;
  appliedAt?: string;
};

export function findByUrl(url: string): Application | null {
  const row = getDb()
    .prepare<[string], ApplicationRow>("SELECT * FROM applications WHERE url = ?")
    .get(url);
  return row ? decorate(row, DEFAULT_STALE_DAYS) : null;
}

export function getApplication(id: number): Application | null {
  const row = getDb()
    .prepare<[number], ApplicationRow>("SELECT * FROM applications WHERE id = ?")
    .get(id);
  return row ? decorate(row, DEFAULT_STALE_DAYS) : null;
}

/**
 * Inserts a new application. If `url` already exists, the existing row is
 * returned untouched — `alreadyExisted` tells the caller which happened.
 */
export function insertApplication(
  input: NewApplication,
): { application: Application; alreadyExisted: boolean } {
  if (input.url) {
    const existing = findByUrl(input.url);
    if (existing) return { application: existing, alreadyExisted: true };
  }

  const timestamp = nowIso();
  const appliedAt = input.appliedAt ?? timestamp;
  const initialNote = input.notes ? `[${timestamp}] ${input.notes}` : null;

  const result = getDb()
    .prepare(
      `INSERT INTO applications
         (company, title, url, source, location, salary, status, applied_at, response_at, last_update, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      input.company,
      input.title,
      input.url ?? null,
      input.source ?? "manual",
      input.location ?? null,
      input.salary ?? null,
      input.status ?? "applied",
      appliedAt,
      timestamp,
      initialNote,
    );

  const created = getApplication(Number(result.lastInsertRowid));
  if (!created) throw new Error("insert succeeded but row could not be read back");
  return { application: created, alreadyExisted: false };
}

/**
 * Moves an application to a new status. Any status past `applied` implies they
 * replied, so `response_at` is stamped automatically when not already set.
 */
export function updateStatus(id: number, status: Status, responseAt?: string): Application | null {
  const existing = getDb()
    .prepare<[number], ApplicationRow>("SELECT * FROM applications WHERE id = ?")
    .get(id);
  if (!existing) return null;

  const timestamp = nowIso();
  const impliesResponse = RESPONDED_STATUSES.includes(status);
  const nextResponseAt =
    responseAt ?? existing.response_at ?? (impliesResponse ? timestamp : null);

  /**
   * Leaving `saved` means "I just applied", so applied_at is re-stamped to now.
   *
   * Without this, a job saved from search weeks ago and applied to today would
   * keep its save date as applied_at — reporting a huge days-since-applied and
   * being derived as `ghosted` the moment it reached `applied`.
   */
  const leavingSaved = existing.status === "saved" && status !== "saved";
  const nextAppliedAt = leavingSaved ? timestamp : existing.applied_at;

  getDb()
    .prepare(
      "UPDATE applications SET status = ?, response_at = ?, applied_at = ?, last_update = ? WHERE id = ?",
    )
    .run(status, nextResponseAt, nextAppliedAt, timestamp, id);

  return getApplication(id);
}

/** Appends a timestamped line to the notes field. */
export function addNote(id: number, note: string): Application | null {
  const existing = getDb()
    .prepare<[number], ApplicationRow>("SELECT * FROM applications WHERE id = ?")
    .get(id);
  if (!existing) return null;

  const timestamp = nowIso();
  const line = `[${timestamp}] ${note}`;
  const merged = existing.notes ? `${existing.notes}\n${line}` : line;

  getDb()
    .prepare("UPDATE applications SET notes = ?, last_update = ? WHERE id = ?")
    .run(merged, timestamp, id);

  return getApplication(id);
}

export type ListOptions = {
  /** Matches the *effective* status, so `ghosted` works as a filter. */
  status?: Status;
  staleDays?: number;
};

export function listApplications(options: ListOptions = {}): Application[] {
  const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
  const rows = getDb()
    .prepare<[], ApplicationRow>("SELECT * FROM applications ORDER BY applied_at DESC, id DESC")
    .all();

  const decorated = rows.map((row) => decorate(row, staleDays));
  // Filter after decorating so `ghosted` is filterable even though it is derived.
  return options.status ? decorated.filter((row) => row.status === options.status) : decorated;
}

export function getStats(options: { staleDays?: number } = {}): Stats {
  const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
  const applications = listApplications({ staleDays });

  const funnel = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<
    Status,
    number
  >;
  for (const application of applications) funnel[application.status] += 1;

  // `saved` is pre-application (found, not applied), so it is NOT part of the
  // response-rate or ghost-rate denominator: rate = responded+ / applied+.
  // Adding 50 jobs from search must not dilute the response rate to 2%.
  const applied = applications.filter((application) => application.status !== "saved");
  const responded = applied.filter((application) => hasResponded(application));
  const ghosted = applied.filter((application) => application.ghosted);

  const responseDays = responded
    .map((application) => application.daysToResponse)
    .filter((days): days is number => days !== null);

  const rate = (count: number) =>
    applied.length === 0 ? 0 : Number((count / applied.length).toFixed(4));

  return {
    total: applications.length,
    totalApplied: applied.length,
    funnel,
    responded: responded.length,
    responseRate: rate(responded.length),
    ghostRate: rate(ghosted.length),
    avgDaysToResponse:
      responseDays.length === 0
        ? null
        : Number(
            (responseDays.reduce((sum, days) => sum + days, 0) / responseDays.length).toFixed(1),
          ),
    staleDays,
  };
}

/** Closes the handle. Only needed by scripts that want a clean exit. */
export function closeDb(): void {
  db?.close();
  db = null;
}
