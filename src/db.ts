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

import { jobKey } from "./jobkey.ts";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/**
 * Full vocabulary, including the derived-only `ghosted`.
 *
 * Lifecycle: `applied` -> `responded` -> `screening` -> `interview`
 * -> `offer` / `rejected`, with `ghosted` derived from a stale `applied`.
 * `dropped` is an exit you can take from any of them.
 *
 * Three ways an application ends, and they are deliberately separate:
 *   `rejected`  they said no
 *   `ghosted`   nobody said anything (derived, never stored)
 *   `dropped`   I walked away — lost interest, took something else, saw the
 *               salary. It is the only ending that is my doing, so it must not
 *               be filed under either of the other two.
 *
 * There is NO pre-application "saved" stage, on purpose: putting a job in the
 * funnel means you applied to it. A bookmark you never sent would sit in the
 * table diluting the response rate, and "have I applied to this?" would need
 * two lookups instead of one.
 */
export const STATUSES = [
  "applied",
  "responded",
  "screening",
  "interview",
  "offer",
  "rejected",
  "dropped",
  "ghosted",
] as const;

export type Status = (typeof STATUSES)[number];

/**
 * Statuses that mean "they got back to me" — used for the response rate.
 *
 * `dropped` is NOT here. A rejection is a reply; me giving up is not, and
 * dropping a job I never heard back from must not count as a response. If they
 * had already replied, `response_at` is set and the row still counts — see
 * hasResponded, which reads the timestamp first.
 */
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
  /** jobKey(url): the identity used for every "is this the same job?" check. */
  url_key: string | null;
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
  /** Every tracked row is a real application — see STATUSES. */
  total: number;
  funnel: Record<Status, number>;
  responded: number;
  responseRate: number; // 0..1 of total
  ghostRate: number; // 0..1 of total
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

    /*
     * Jobs hidden from search: "not interested, stop showing me this".
     *
     * A separate table rather than an applications status, on purpose. A
     * dismissed job is not an application — putting it in the funnel would
     * inflate the counts and pollute the tracker table with things you never
     * applied to. Keeping it apart also means un-dismissing is a plain delete.
     */
    CREATE TABLE IF NOT EXISTS dismissed (
      url          TEXT PRIMARY KEY,
      company      TEXT,
      title        TEXT,
      reason       TEXT,
      dismissed_at TEXT NOT NULL
    );
  `);

  /*
   * Backfill for databases written before `saved` was removed. Left alone, such
   * a row shows a status the dropdown cannot even select, and getStats counts
   * it in a bucket that no longer exists.
   */
  database.exec("UPDATE applications SET status = 'applied' WHERE status = 'saved'");

  /*
   * url_key: the job's identity, independent of tracking parameters (see
   * jobkey.ts). Both tables used to match on the exact URL, so when Himalayas
   * started appending ?utm_source=api every hidden and applied Himalayas job
   * came back as new, and "В воронку" on one inserted a second application.
   * The url column stays as the link to open; url_key is what gets compared.
   *
   * Not UNIQUE: two stored rows may legitimately collapse to one key, and the
   * migration must not fail on them. Rows written by an older process without
   * a key are filled in on the next open, and lookups fall back to url.
   */
  for (const table of ["applications", "dismissed"]) {
    const columns = database.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all();
    if (!columns.some((column) => column.name === "url_key")) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN url_key TEXT`);
    }
    database.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_url_key ON ${table}(url_key)`);
    const missing = database
      // Aliased: on a table with an INTEGER PRIMARY KEY, SQLite reports a bare
      // `rowid` under that key's name, and row.rowid would be undefined.
      .prepare<[], { rid: number; url: string }>(
        `SELECT rowid AS rid, url FROM ${table} WHERE url IS NOT NULL AND url_key IS NULL`,
      )
      .all();
    const fill = database.prepare(`UPDATE ${table} SET url_key = ? WHERE rowid = ?`);
    database.transaction(() => {
      for (const row of missing) fill.run(jobKey(row.url), row.rid);
    })();
  }
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

/** Matches on jobKey, so a tracking-parameter variant finds the same row. */
export function findByUrl(url: string): Application | null {
  const row = getDb()
    .prepare<[string, string], ApplicationRow>(
      "SELECT * FROM applications WHERE url_key = ? OR url = ? ORDER BY id LIMIT 1",
    )
    .get(jobKey(url), url);
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
         (company, title, url, url_key, source, location, salary, status, applied_at, response_at, last_update, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    )
    .run(
      input.company,
      input.title,
      input.url ?? null,
      input.url ? jobKey(input.url) : null,
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

  // applied_at is never re-stamped: it is set when the row is created, which is
  // the moment you applied.
  getDb()
    .prepare("UPDATE applications SET status = ?, response_at = ?, last_update = ? WHERE id = ?")
    .run(status, nextResponseAt, timestamp, id);

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

  // Every tracked row is an application, so the whole table is the denominator.
  const responded = applications.filter((application) => hasResponded(application));
  const ghosted = applications.filter((application) => application.ghosted);

  const responseDays = responded
    .map((application) => application.daysToResponse)
    .filter((days): days is number => days !== null);

  const rate = (count: number) =>
    applications.length === 0 ? 0 : Number((count / applications.length).toFixed(4));

  return {
    total: applications.length,
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

/* ------------------------------------------------------------------ */
/* Dismissed jobs — hidden from every search                           */
/* ------------------------------------------------------------------ */

export type DismissedJob = {
  url: string;
  url_key: string | null;
  company: string | null;
  title: string | null;
  reason: string | null;
  dismissed_at: string;
};

export type NewDismissal = {
  url: string;
  company?: string | null;
  title?: string | null;
  reason?: string | null;
};

/**
 * Hide a job from future searches. Idempotent: dismissing twice keeps the
 * original timestamp rather than erroring, so a double click is harmless.
 */
export function dismissJob(input: NewDismissal): { dismissed: DismissedJob; alreadyHidden: boolean } {
  const key = jobKey(input.url);
  const existing = getDb()
    .prepare<[string, string], DismissedJob>("SELECT * FROM dismissed WHERE url_key = ? OR url = ?")
    .get(key, input.url);
  if (existing) return { dismissed: existing, alreadyHidden: true };

  getDb()
    .prepare(
      `INSERT INTO dismissed (url, url_key, company, title, reason, dismissed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.url,
      key,
      input.company ?? null,
      input.title ?? null,
      input.reason ?? null,
      nowIso(),
    );

  const dismissed = getDb()
    .prepare<[string], DismissedJob>("SELECT * FROM dismissed WHERE url = ?")
    .get(input.url);
  if (!dismissed) throw new Error("dismissal was written but could not be read back");
  return { dismissed, alreadyHidden: false };
}

/**
 * Un-hide a job. Returns false when it was not hidden in the first place.
 * Removes every stored variant of the job, so a restore cannot leave a second
 * row behind that keeps it hidden.
 */
export function undismissJob(url: string): boolean {
  return (
    getDb().prepare("DELETE FROM dismissed WHERE url_key = ? OR url = ?").run(jobKey(url), url)
      .changes > 0
  );
}

/** jobKeys of every hidden job — compare them with jobKey(job.url). */
export function listDismissedKeys(): string[] {
  return getDb()
    .prepare<[], { url: string; url_key: string | null }>("SELECT url, url_key FROM dismissed")
    .all()
    .map((row) => row.url_key ?? jobKey(row.url));
}

export function listDismissed(): DismissedJob[] {
  return getDb()
    .prepare<[], DismissedJob>("SELECT * FROM dismissed ORDER BY dismissed_at DESC")
    .all();
}

/** Closes the handle. Only needed by scripts that want a clean exit. */
export function closeDb(): void {
  db?.close();
  db = null;
}
