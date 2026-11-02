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
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { jobKey } from "./jobkey.ts";
import type { Job } from "./sources.ts";

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
  /** When the posting was published (or first seen): how early I applied. */
  posted_at: string | null;
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

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/*
 * better-sqlite3's native half is built for one Node ABI, and the app runs
 * whichever node is on PATH: after an `nvm use` every query fails with
 * NODE_MODULE_VERSION. So rebuild it for this node and open again. Not on every
 * open while that keeps failing (offline, a process on the old node holding the
 * file): a rebuild blocks, and the verdict queue alone opens every two minutes.
 */
const REBUILD_EVERY_MS = 10 * 60_000;
let lastRebuild = -Infinity;

/** A native binary that is missing or not for this node, not a bad database file. */
function isNativeLoadError(error: unknown): boolean {
  const { code, message } = error as { code?: string; message?: string };
  return code === "ERR_DLOPEN_FAILED" || /Could not locate the bindings file/.test(message ?? "");
}

export function openRebuilding<T>(open: () => T, rebuild: () => void, now = Date.now()): T {
  try {
    return open();
  } catch (error) {
    if (!isNativeLoadError(error) || now - lastRebuild < REBUILD_EVERY_MS) throw error;
    lastRebuild = now;
    console.error(`better-sqlite3 does not load on Node ${process.version}: rebuilding it`);
    try {
      rebuild();
    } catch (failure) {
      console.error(`Rebuild failed: ${failure instanceof Error ? failure.message : failure}`);
      throw error;
    }
    const opened = open();
    console.error(`better-sqlite3 rebuilt for Node ${process.version}`);
    return opened;
  }
}

function rebuildNative(): void {
  execSync("npm rebuild better-sqlite3", {
    cwd: PROJECT_ROOT,
    // This node's folder first: the build must target it, not the one on PATH.
    env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env["PATH"]}` },
    // Nothing on stdout: for the MCP server that is the protocol.
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 5 * 60_000,
    windowsHide: true,
  });
}

let db: Database.Database | null = null;

/** Opens (and on first call creates) the database. Safe to call repeatedly. */
export function getDb(): Database.Database {
  if (db) return db;

  const path = resolveDbPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  db = openRebuilding(() => new Database(path), rebuildNative);
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

    /*
     * What the boards returned, kept between searches (src/refresh.ts fills it
     * in the background). Board data, not applications: the Tracker and
     * getStats never read it, so the funnel stays applications-only — unlike
     * the removed \`npm run harvest\`, which filed finds into the funnel.
     *
     * data is the normalized Job as JSON, description included. first_seen is
     * when this tool first saw the posting: boards re-stamp postedAt on every
     * renewal (Himalayas every 30 days, justjoin.it on each refresh), so it is
     * the only honest "how new is this" and what "new since last visit" uses.
     */
    CREATE TABLE IF NOT EXISTS postings (
      source     TEXT NOT NULL,
      job_key    TEXT NOT NULL,
      data       TEXT NOT NULL,
      posted_at  TEXT,
      first_seen TEXT NOT NULL,
      last_seen  TEXT NOT NULL,
      PRIMARY KEY (source, job_key)
    );
    CREATE INDEX IF NOT EXISTS idx_postings_last_seen ON postings(last_seen);

    /* One row per board refresh: when it last worked, and why it did not. */
    CREATE TABLE IF NOT EXISTS fetch_runs (
      id          INTEGER PRIMARY KEY,
      source      TEXT NOT NULL,
      started_at  TEXT NOT NULL,
      finished_at TEXT,
      hours_old   INTEGER,
      rows        INTEGER,
      error       TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_fetch_runs_source ON fetch_runs(source, started_at);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    /*
     * Application attempts that did not end in "applied" (scripts/apply.mjs
     * writes one per run): a code to type, a CAPTCHA, an account wall, a
     * missing answer, a failed submit. Not applications — the funnel stays
     * applications-only. An attempt stops being open once the job is applied
     * to or hidden.
     */
    CREATE TABLE IF NOT EXISTS attempts (
      id         INTEGER PRIMARY KEY,
      job_key    TEXT NOT NULL,
      url        TEXT NOT NULL,
      apply_url  TEXT,
      company    TEXT,
      title      TEXT,
      at         TEXT NOT NULL,
      result     TEXT NOT NULL,
      detail     TEXT,
      screenshot TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_attempts_job_key ON attempts(job_key);

    /*
     * Claude's verdict on a posting (src/verdict.ts): apply / maybe / skip,
     * with its reasons in details (the structured output, as JSON). One row
     * per job, replaced on a re-run. criteria is the version of the criteria
     * it was made under — an older one shows as stale. session_id is the
     * Claude Code session it came from, which "обсудить в Claude" reopens.
     * requested: 'auto' (the background queue) or 'manual' (a card asked).
     */
    CREATE TABLE IF NOT EXISTS verdicts (
      job_key      TEXT PRIMARY KEY,
      url          TEXT NOT NULL,
      company      TEXT,
      title        TEXT,
      verdict      TEXT NOT NULL,
      score        INTEGER,
      summary      TEXT,
      details      TEXT NOT NULL,
      session_id   TEXT,
      model        TEXT,
      criteria     TEXT NOT NULL,
      requested    TEXT NOT NULL,
      text_chars   INTEGER,
      cost_usd     REAL,
      duration_ms  INTEGER,
      evaluated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_verdicts_evaluated_at ON verdicts(evaluated_at);

    /*
     * The posting text a verdict last read, per job. LinkedIn, nofluffjobs and
     * justjoin.it store no description, so this is the only copy of what
     * Claude judged: without it a criteria change cannot be checked on the
     * same texts, and re-judging means reading every page again. Before this
     * table the text lived only in Claude Code's session files, which are
     * deleted after 30 days. via: stored | fetched | session (recovered from
     * one of those files).
     */
    /*
     * The text of src/verdict-criteria.md under each criteria version, from
     * the first time the version was used. verdicts.criteria holds only the
     * hash: without the text, "по старым критериям" could not say what changed,
     * and an edit could not be taken back.
     */
    CREATE TABLE IF NOT EXISTS criteria_versions (
      version       TEXT PRIMARY KEY,
      text          TEXT NOT NULL,
      first_seen_at TEXT NOT NULL
    );

    /*
     * «Верно» / «Мимо» on a card: what Claude's verdict should have been for
     * this posting, in my words — the labels the criteria are checked against
     * (src/verdict-eval.ts). One row per job, the latest mark; verdict and
     * criteria are what was on the card when I marked it.
     */
    CREATE TABLE IF NOT EXISTS verdict_feedback (
      job_key  TEXT PRIMARY KEY,
      expected TEXT NOT NULL,
      verdict  TEXT NOT NULL,
      score    INTEGER,
      criteria TEXT NOT NULL,
      at       TEXT NOT NULL
    );

    /*
     * What I did with a card and what Claude had said about it at that
     * moment: hide (with the reason), restore, add to the funnel, mark. The
     * verdicts table is overwritten on every re-run, and dismissed and
     * applications keep no verdict, so without this no action could be set
     * against the verdict it answered.
     */
    CREATE TABLE IF NOT EXISTS decisions (
      id       INTEGER PRIMARY KEY,
      job_key  TEXT NOT NULL,
      action   TEXT NOT NULL,
      reason   TEXT,
      verdict  TEXT,
      score    INTEGER,
      criteria TEXT,
      at       TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_job_key ON decisions(job_key);

    CREATE TABLE IF NOT EXISTS posting_texts (
      job_key  TEXT PRIMARY KEY,
      text     TEXT NOT NULL,
      via      TEXT NOT NULL,
      read_at  TEXT NOT NULL,
      location TEXT
    );

    /*
     * «Правило ошиблось»: cards a screening rule hid that I want shown anyway
     * (src/screening.ts lets them past every hiding rule). The rule and the
     * card as they were, so Настройки → Правила can list them and the misfire
     * is on record against the rule.
     */
    CREATE TABLE IF NOT EXISTS rule_overrides (
      job_key TEXT PRIMARY KEY,
      reason  TEXT NOT NULL,
      title   TEXT,
      company TEXT,
      at      TEXT NOT NULL
    );

    /*
     * Настройки → Компании и память: a blocked company given back ("company",
     * its companyKey) or a hide that should stop teaching ("hide", its job
     * key). The hide itself stays — that posting is still hidden.
     */
    /*
     * Which search query found a stored posting (one row per query that
     * returned it), for Настройки → Поиск: what each query brings, and what
     * only it brings. Boards read whole each pass have none.
     */
    CREATE TABLE IF NOT EXISTS posting_queries (
      source     TEXT NOT NULL,
      job_key    TEXT NOT NULL,
      query      TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen  TEXT NOT NULL,
      PRIMARY KEY (source, job_key, query)
    );

    CREATE TABLE IF NOT EXISTS memory_forget (
      kind  TEXT NOT NULL,
      key   TEXT NOT NULL,
      label TEXT,
      at    TEXT NOT NULL,
      PRIMARY KEY (kind, key)
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
  // How long after publication I applied — the one thing that can be learned
  // about timing once replies come in. Nullable: older rows never had it.
  const appColumns = database.prepare<[], { name: string }>("PRAGMA table_info(applications)").all();
  if (!appColumns.some((column) => column.name === "posted_at")) {
    database.exec("ALTER TABLE applications ADD COLUMN posted_at TEXT");
  }

  // The place the posting's page gives (LinkedIn's "Poland", which JobSpy drops
  // from about 15% of its rows): a re-judge from the saved text used to lose it.
  // "" means the page was read and named none.
  const textColumns = database.prepare<[], { name: string }>("PRAGMA table_info(posting_texts)").all();
  if (!textColumns.some((column) => column.name === "location")) {
    database.exec("ALTER TABLE posting_texts ADD COLUMN location TEXT");
  }

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

/** An ISO date string, or null for anything that does not parse. */
function validIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
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
  /** The posting's publication date (or when it was first seen), if known. */
  postedAt?: string | null;
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
         (company, title, url, url_key, source, location, salary, status, applied_at, response_at, last_update, notes, posted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
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
      validIso(input.postedAt),
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

/** undismissJob by the job's key, for copies known only by key (dedupe aliases). */
export function undismissKey(key: string): boolean {
  return getDb().prepare("DELETE FROM dismissed WHERE url_key = ?").run(key).changes > 0;
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

/* ------------------------------------------------------------------ */
/* Postings — board data kept between searches (see src/refresh.ts)     */
/* ------------------------------------------------------------------ */

/** A stored posting, with when this tool first and last saw it. */
export type StoredJob = Job & { firstSeenAt: string; lastSeenAt: string };

/**
 * Writes one board's fetch. A posting seen before keeps its first_seen; a new
 * one gets now — except on a board's very first fetch, where everything would
 * otherwise look "new": there first_seen is its own posting date.
 */
export function upsertPostings(source: string, jobs: Job[]): { inserted: number; updated: number } {
  const database = getDb();
  const now = nowIso();
  const initial =
    database.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM postings WHERE source = ?").get(source)
      ?.n === 0;
  const existing = database.prepare<[string, string], { first_seen: string }>(
    "SELECT first_seen FROM postings WHERE source = ? AND job_key = ?",
  );
  const insert = database.prepare(
    `INSERT INTO postings (source, job_key, data, posted_at, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const update = database.prepare(
    "UPDATE postings SET data = ?, posted_at = ?, last_seen = ? WHERE source = ? AND job_key = ?",
  );
  const found = database.prepare(
    `INSERT INTO posting_queries (source, job_key, query, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(source, job_key, query) DO UPDATE SET last_seen = excluded.last_seen`,
  );
  let inserted = 0;
  let updated = 0;
  database.transaction(() => {
    for (const { foundBy, ...job } of jobs) {
      const key = jobKey(job.url);
      if (foundBy) found.run(source, key, foundBy, now, now);
      const data = JSON.stringify(job);
      if (existing.get(source, key)) {
        update.run(data, job.postedAt, now, source, key);
        updated++;
      } else {
        const firstSeen =
          initial && job.postedAt && job.postedAt < now ? job.postedAt : now;
        insert.run(source, key, data, job.postedAt, firstSeen, now);
        inserted++;
      }
    }
  })();
  return { inserted, updated };
}

/** The queries behind the postings still stored. */
export function listPostingQueries(): Array<{ source: string; job_key: string; query: string }> {
  return getDb()
    .prepare<[], { source: string; job_key: string; query: string }>(
      `SELECT q.source, q.job_key, q.query FROM posting_queries q
       JOIN postings p ON p.source = q.source AND p.job_key = q.job_key`,
    )
    .all();
}

/** Stored postings per board. */
export function postingCounts(): Record<string, number> {
  const rows = getDb()
    .prepare<[], { source: string; n: number }>("SELECT source, COUNT(*) AS n FROM postings GROUP BY source")
    .all();
  return Object.fromEntries(rows.map((row) => [row.source, row.n]));
}

/** Which boards store each job key: a key on two boards is the same posting seen twice. */
export function postingSources(): Map<string, Set<string>> {
  const bySource = new Map<string, Set<string>>();
  for (const row of getDb().prepare<[], { job_key: string; source: string }>("SELECT job_key, source FROM postings").all()) {
    const set = bySource.get(row.job_key) ?? new Set<string>();
    set.add(row.source);
    bySource.set(row.job_key, set);
  }
  return bySource;
}

export function loadPostings(sources: readonly string[]): StoredJob[] {
  if (sources.length === 0) return [];
  const rows = getDb()
    .prepare<string[], { data: string; first_seen: string; last_seen: string }>(
      `SELECT data, first_seen, last_seen FROM postings WHERE source IN (${sources.map(() => "?").join(",")})`,
    )
    .all(...sources);
  return rows.map((row) => ({
    ...(JSON.parse(row.data) as Job),
    firstSeenAt: row.first_seen,
    lastSeenAt: row.last_seen,
  }));
}

/**
 * Drops postings that are gone or too old to show:
 *   - not seen for 3 days by a board that has refreshed successfully since —
 *     a board that is down does not empty its own shelf. Days, not one pass:
 *     identical Indeed requests return slightly different sets, and a posting
 *     that blinks out for one pass must not come back as "new".
 *     LinkedIn is fetched incrementally (only what is new), so absence means
 *     nothing there; it ages out by date only.
 *   - LinkedIn only: first seen or posted more than 45 days ago, whichever is
 *     earlier.
 */
export function prunePostings(incrementalSources: readonly string[]): number {
  const database = getDb();
  let removed = 0;
  const sources = database.prepare<[], { source: string }>("SELECT DISTINCT source FROM postings").all();
  for (const { source } of sources) {
    if (incrementalSources.includes(source)) continue;
    const success = lastFetch(source).lastSuccessAt;
    if (!success) continue;
    const cutoff = new Date(Date.parse(success) - 3 * 86_400_000).toISOString();
    removed += database
      .prepare("DELETE FROM postings WHERE source = ? AND last_seen < ?")
      .run(source, cutoff).changes;
  }
  // By age only where absence means nothing. A board fetched in full still
  // lists an old posting it has not taken down; deleting it would only bring
  // it back as "new" on the next pass. The date window hides it anyway.
  const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
  for (const source of incrementalSources) {
    removed += database
      .prepare("DELETE FROM postings WHERE source = ? AND MIN(first_seen, COALESCE(posted_at, first_seen)) < ?")
      .run(source, old).changes;
  }
  if (removed > 0) {
    database.exec(
      `DELETE FROM posting_queries WHERE NOT EXISTS
         (SELECT 1 FROM postings p WHERE p.source = posting_queries.source AND p.job_key = posting_queries.job_key)`,
    );
  }
  return removed;
}

export type FetchState = {
  lastSuccessAt: string | null;
  /** When that successful run started: every posting it listed has last_seen at or after this. */
  lastSuccessStartedAt: string | null;
  lastRunAt: string | null;
  /** Error of the most recent finished run, if it failed. */
  lastError: string | null;
  /** A run started in the last 15 minutes and not finished — by any process. */
  running: boolean;
};

export function lastFetch(source: string): FetchState {
  const database = getDb();
  const success = database
    .prepare<[string], { started_at: string; finished_at: string }>(
      "SELECT started_at, finished_at FROM fetch_runs WHERE source = ? AND finished_at IS NOT NULL AND error IS NULL ORDER BY id DESC LIMIT 1",
    )
    .get(source);
  const last = database
    .prepare<[string], { started_at: string; finished_at: string | null; error: string | null }>(
      "SELECT started_at, finished_at, error FROM fetch_runs WHERE source = ? ORDER BY id DESC LIMIT 1",
    )
    .get(source);
  const running =
    last !== undefined &&
    last.finished_at === null &&
    Date.now() - Date.parse(last.started_at) < 15 * 60_000;
  return {
    lastSuccessAt: success?.finished_at ?? null,
    lastSuccessStartedAt: success?.started_at ?? null,
    lastRunAt: last?.finished_at ?? last?.started_at ?? null,
    lastError: last?.finished_at ? last.error : null,
    running,
  };
}

export function startFetchRun(source: string, hoursOld: number): number {
  const result = getDb()
    .prepare("INSERT INTO fetch_runs (source, started_at, hours_old) VALUES (?, ?, ?)")
    .run(source, nowIso(), hoursOld);
  return Number(result.lastInsertRowid);
}

export function finishFetchRun(id: number, rows: number, error: string | null): void {
  getDb()
    .prepare("UPDATE fetch_runs SET finished_at = ?, rows = ?, error = ? WHERE id = ?")
    .run(nowIso(), rows, error, id);
}

/**
 * Changes whenever any board refresh finishes, in this process or another
 * (the scheduled `npm run refresh`). The dashboard rebuilds its feed on change.
 *
 * A count, not the highest finished id: boards are fetched side by side, and
 * one that started first can finish last — Indeed after Himalayas — leaving
 * the highest id where it was, so a feed built between the two kept missing
 * the slower board's postings. Runs are never deleted, so the count only grows.
 */
export function postingsVersion(): number {
  return (
    getDb()
      .prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM fetch_runs WHERE finished_at IS NOT NULL")
      .get()?.n ?? 0
  );
}

export function getMeta(key: string): string | null {
  return getDb().prepare<[string], { value: string }>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  getDb()
    .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

/* ------------------------------------------------------------------ */
/* Attempts — applications that need me                                */
/* ------------------------------------------------------------------ */

export type Attempt = {
  id: number;
  job_key: string;
  url: string;
  apply_url: string | null;
  company: string | null;
  title: string | null;
  at: string;
  result: string;
  detail: string | null;
  screenshot: string | null;
  /** How many runs this job has had. */
  tries: number;
};

export function recordAttempt(input: {
  url: string;
  applyUrl?: string | null;
  company?: string | null;
  title?: string | null;
  result: string;
  detail?: string | null;
  screenshot?: string | null;
}): void {
  getDb()
    .prepare(
      `INSERT INTO attempts (job_key, url, apply_url, company, title, at, result, detail, screenshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      jobKey(input.url),
      input.url,
      input.applyUrl ?? null,
      input.company ?? null,
      input.title ?? null,
      nowIso(),
      input.result,
      input.detail ?? null,
      input.screenshot ?? null,
    );
}

/** The latest attempt per job, for jobs not yet applied to or hidden. */
export function listOpenAttempts(): Attempt[] {
  return getDb()
    .prepare<[], Attempt>(
      `SELECT a.*, latest.tries AS tries
         FROM attempts a
         JOIN (SELECT job_key, MAX(id) AS id, COUNT(*) AS tries FROM attempts GROUP BY job_key) latest
           ON latest.id = a.id
        WHERE a.job_key NOT IN (SELECT url_key FROM applications WHERE url_key IS NOT NULL)
          AND a.job_key NOT IN (SELECT url_key FROM dismissed WHERE url_key IS NOT NULL)
        ORDER BY a.id DESC`,
    )
    .all();
}

/* ------------------------------------------------------------------ */
/* Verdicts — Claude's read of a posting (see src/verdict.ts)           */
/* ------------------------------------------------------------------ */

export type VerdictRow = {
  job_key: string;
  url: string;
  company: string | null;
  title: string | null;
  verdict: "apply" | "maybe" | "skip";
  score: number | null;
  summary: string | null;
  /** The structured output as JSON: reasons, work mode, salary, hide reason. */
  details: string;
  session_id: string | null;
  model: string | null;
  criteria: string;
  requested: "auto" | "manual";
  text_chars: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  evaluated_at: string;
};

export type NewVerdict = Omit<VerdictRow, "job_key" | "evaluated_at">;

/** Stores a verdict for the job, replacing an earlier one. */
export function saveVerdict(input: NewVerdict): VerdictRow {
  const row: VerdictRow = { ...input, job_key: jobKey(input.url), evaluated_at: nowIso() };
  getDb()
    .prepare(
      `INSERT INTO verdicts (job_key, url, company, title, verdict, score, summary, details, session_id,
                             model, criteria, requested, text_chars, cost_usd, duration_ms, evaluated_at)
       VALUES (@job_key, @url, @company, @title, @verdict, @score, @summary, @details, @session_id,
               @model, @criteria, @requested, @text_chars, @cost_usd, @duration_ms, @evaluated_at)
       ON CONFLICT(job_key) DO UPDATE SET
         url = excluded.url, company = excluded.company, title = excluded.title,
         verdict = excluded.verdict, score = excluded.score, summary = excluded.summary,
         details = excluded.details, session_id = excluded.session_id, model = excluded.model,
         criteria = excluded.criteria, requested = excluded.requested, text_chars = excluded.text_chars,
         cost_usd = excluded.cost_usd, duration_ms = excluded.duration_ms, evaluated_at = excluded.evaluated_at`,
    )
    .run(row);
  return row;
}

export function getVerdict(key: string): VerdictRow | null {
  return getDb().prepare<[string], VerdictRow>("SELECT * FROM verdicts WHERE job_key = ?").get(key) ?? null;
}

/**
 * All of them, or those made at or after `since` (ISO). A few hundred rows at
 * most. At, not after: a verdict saved in the same millisecond as the last
 * read would otherwise fall between two reads for good.
 */
export function listVerdicts(since?: string): VerdictRow[] {
  return since
    ? getDb().prepare<[string], VerdictRow>("SELECT * FROM verdicts WHERE evaluated_at >= ?").all(since)
    : getDb().prepare<[], VerdictRow>("SELECT * FROM verdicts").all();
}

export type FeedbackRow = { job_key: string; expected: string; verdict: string; score: number | null; criteria: string; at: string };

/** «Верно» / «Мимо»: the verdict this posting should have had. A later mark replaces an earlier one. */
export function saveFeedback(row: Omit<FeedbackRow, "at">): FeedbackRow {
  const saved = { ...row, at: nowIso() };
  getDb()
    .prepare(
      `INSERT INTO verdict_feedback (job_key, expected, verdict, score, criteria, at)
       VALUES (@job_key, @expected, @verdict, @score, @criteria, @at)
       ON CONFLICT(job_key) DO UPDATE SET expected = excluded.expected, verdict = excluded.verdict,
         score = excluded.score, criteria = excluded.criteria, at = excluded.at`,
    )
    .run(saved);
  return saved;
}

export function listFeedback(): FeedbackRow[] {
  return getDb().prepare<[], FeedbackRow>("SELECT * FROM verdict_feedback").all();
}

export type DecisionRow = {
  id: number;
  job_key: string;
  action: string;
  reason: string | null;
  verdict: string | null;
  score: number | null;
  criteria: string | null;
  at: string;
};

/** One action on a card, with the verdict it answered (verdict.ts reads that in). */
export function recordDecision(row: Omit<DecisionRow, "id" | "at">): void {
  getDb()
    .prepare(
      `INSERT INTO decisions (job_key, action, reason, verdict, score, criteria, at)
       VALUES (@job_key, @action, @reason, @verdict, @score, @criteria, @at)`,
    )
    .run({ ...row, at: nowIso() });
}

export function listDecisions(): DecisionRow[] {
  return getDb().prepare<[], DecisionRow>("SELECT * FROM decisions ORDER BY id").all();
}

export type RuleOverrideRow = { job_key: string; reason: string; title: string | null; company: string | null; at: string };

export function saveRuleOverride(row: Omit<RuleOverrideRow, "at">): RuleOverrideRow {
  const saved = { ...row, at: nowIso() };
  getDb()
    .prepare(
      `INSERT INTO rule_overrides (job_key, reason, title, company, at) VALUES (@job_key, @reason, @title, @company, @at)
       ON CONFLICT(job_key) DO UPDATE SET reason = excluded.reason, title = excluded.title, company = excluded.company, at = excluded.at`,
    )
    .run(saved);
  return saved;
}

export function deleteRuleOverride(key: string): boolean {
  return getDb().prepare("DELETE FROM rule_overrides WHERE job_key = ?").run(key).changes > 0;
}

export function listRuleOverrides(): RuleOverrideRow[] {
  return getDb().prepare<[], RuleOverrideRow>("SELECT * FROM rule_overrides ORDER BY at DESC").all();
}

export type ForgetRow = { kind: "company" | "hide"; key: string; label: string | null; at: string };

export function saveForget(row: Omit<ForgetRow, "at">): ForgetRow {
  const saved = { ...row, at: nowIso() };
  getDb()
    .prepare(
      `INSERT INTO memory_forget (kind, key, label, at) VALUES (@kind, @key, @label, @at)
       ON CONFLICT(kind, key) DO UPDATE SET label = excluded.label, at = excluded.at`,
    )
    .run(saved);
  return saved;
}

export function deleteForget(kind: string, key: string): boolean {
  return getDb().prepare("DELETE FROM memory_forget WHERE kind = ? AND key = ?").run(kind, key).changes > 0;
}

export function listForget(): ForgetRow[] {
  return getDb().prepare<[], ForgetRow>("SELECT * FROM memory_forget ORDER BY at DESC").all();
}

export type CriteriaVersionRow = { version: string; text: string; first_seen_at: string };

/** Keeps a criteria version's text the first time it is seen. */
export function saveCriteriaVersion(version: string, text: string): void {
  getDb()
    .prepare("INSERT OR IGNORE INTO criteria_versions (version, text, first_seen_at) VALUES (?, ?, ?)")
    .run(version, text, nowIso());
}

export function listCriteriaVersions(limit: number): CriteriaVersionRow[] {
  return getDb()
    .prepare<[number], CriteriaVersionRow>("SELECT * FROM criteria_versions ORDER BY first_seen_at DESC LIMIT ?")
    .all(limit);
}

export type PostingText = { job_key: string; text: string; via: string; read_at: string; location: string | null };

/**
 * Keeps the text a verdict read; a later read of the same job replaces it.
 * `readAt` only for recovered texts. A later read without a place keeps the
 * place an earlier one found.
 */
export function savePostingText(key: string, text: string, via: string, readAt = nowIso(), location: string | null = null): void {
  getDb()
    .prepare(
      `INSERT INTO posting_texts (job_key, text, via, read_at, location) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(job_key) DO UPDATE SET text = excluded.text, via = excluded.via, read_at = excluded.read_at,
         location = COALESCE(excluded.location, posting_texts.location)
       WHERE excluded.read_at >= posting_texts.read_at`,
    )
    .run(key, text, via, readAt, location);
}

/** The place each read page gave, by job: the feed shows it where the board gave none. */
export function listPostingPlaces(): Map<string, string> {
  const rows = getDb()
    .prepare<[], { job_key: string; location: string }>("SELECT job_key, location FROM posting_texts WHERE location IS NOT NULL AND location <> ''")
    .all();
  return new Map(rows.map((row) => [row.job_key, row.location]));
}

export function getPostingText(key: string): PostingText | null {
  return getDb().prepare<[string], PostingText>("SELECT * FROM posting_texts WHERE job_key = ?").get(key) ?? null;
}

/** Every stored copy of a job: one per board that stored the same link. */
export function findPostings(key: string): StoredJob[] {
  return getDb()
    .prepare<[string], { data: string; first_seen: string; last_seen: string }>(
      "SELECT data, first_seen, last_seen FROM postings WHERE job_key = ?",
    )
    .all(key)
    .map((row) => ({
      ...(JSON.parse(row.data) as Job),
      firstSeenAt: row.first_seen,
      lastSeenAt: row.last_seen,
    }));
}

/** Closes the handle. Only needed by scripts that want a clean exit. */
export function closeDb(): void {
  db?.close();
  db = null;
}
