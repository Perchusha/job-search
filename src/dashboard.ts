/**
 * dashboard.ts — local read/write view of the same SQLite file the MCP uses.
 *
 * node:http, no build step. Binds to localhost by default; JOBHUNT_HOST can
 * expose it to the local network when launched by the Windows app.
 *
 * The page is src/dashboard.html; its fonts come from node_modules at
 * /fonts.css. Nothing is fetched off this machine.
 */

import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_STALE_DAYS,
  STATUSES,
  dismissJob,
  findPostings,
  getStats,
  getVerdict,
  insertApplication,
  listApplications,
  listDismissed,
  listDismissedKeys,
  listOpenAttempts,
  recordAttempt,
  lastFetch,
  postingsVersion,
  getMeta,
  setMeta,
  resolveDbPath,
  undismissJob,
  updateStatus,
  type Status,
} from "./db.ts";
import { getRun, refusal, startApply } from "./apply-runner.ts";
import { jobKey } from "./jobkey.ts";
import { presentJob, searchStored } from "./pipeline.ts";
import { currentRefresh, describe, refreshDue, refreshing } from "./refresh.ts";
import type { SourceName } from "./sources.ts";
import { buildContext, screenAll } from "./screening.ts";
import { SEARCH_DEFAULTS, TARGET_QUERIES } from "./profile.ts";
import {
  autoRunsToday,
  claudeSettings,
  defaultClaudeSettings,
  dropQueued,
  openSession,
  queueShown,
  requestVerdict,
  saveClaudeSettings,
  SessionGone,
  verdictPending,
  verdictStatus,
  verdictViews,
} from "./verdict.ts";

const PORT = Number(process.env["JOBHUNT_PORT"] ?? 4321);
const HOST = process.env["JOBHUNT_HOST"]?.trim() || "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;

type SearchResult = ReturnType<typeof searchStored>;

/**
 * The ranked feed, built from the postings table (src/refresh.ts keeps it
 * filled) rather than from the boards. Rebuilt only when a board refresh has
 * finished since — in this process or the scheduled `npm run refresh` — so a
 * search costs a few milliseconds and a restart costs nothing.
 *
 * One entry per set of boards (the source pills), holding the whole ranked
 * month, hidden jobs included: /api/search cuts the date window and drops the
 * hidden ones per request, so neither a date chip nor "скрыть" asks a board.
 */
const feeds = new Map<string, { version: number; result: SearchResult }>();

/** Not sliced: hidden jobs are dropped per request, the page limit applies after. */
const FEED_LIMIT = 10_000;

function storedFeed(sources: readonly SourceName[]): SearchResult {
  const version = postingsVersion();
  const key = [...sources].sort().join(",");
  const cached = feeds.get(key);
  if (cached && cached.version === version) return cached.result;
  const result = searchStored({ excludeUrls: [], limit: FEED_LIMIT, sources: [...sources] });
  feeds.set(key, { version, result });
  return result;
}

/**
 * Waits for a board's first fill: a search must not show Himalayas alone just
 * because Indeed's first pass is a second slower. Once a board has been
 * fetched (or has failed) its stored data is used and refreshes run behind.
 */
async function ensureStored(sources: readonly SourceName[]): Promise<void> {
  const unfilled = () =>
    sources.filter((source) => {
      const state = lastFetch(source);
      return state.lastSuccessAt === null && state.lastError === null;
    });
  if (unfilled().length === 0) return;
  await (currentRefresh() ?? refreshDue({ sources: unfilled() }));
}

function freshness(sources: readonly SourceName[]) {
  return {
    refreshing: refreshing(),
    sources: Object.fromEntries(
      sources.map((source) => {
        const state = lastFetch(source);
        return [source, { lastSuccessAt: state.lastSuccessAt, lastError: state.lastError }];
      }),
    ),
  };
}

/** When the Search tab was last opened; postings first seen after it are "new". */
const LAST_VISIT = "last_visit_at";

/**
 * Read once at boot rather than per request. A missing file means a broken
 * install, and failing here says so plainly instead of serving an unstyled page.
 */
const localRequire = createRequire(import.meta.url);

const FONT_FILES = new Map<string, Buffer>();

function loadFontPackageCss(
  packageName: string,
  packagedFamily: string,
  publicFamily: string,
): string {
  const cssPath = localRequire.resolve(`${packageName}/index.css`);
  const css = readFileSync(cssPath, "utf8");
  for (const match of css.matchAll(/url\(\.\/files\/([^)]+)\)/g)) {
    const filename = match[1];
    if (!filename || FONT_FILES.has(filename)) continue;
    FONT_FILES.set(filename, readFileSync(join(dirname(cssPath), "files", filename)));
  }
  return css
    .replaceAll(packagedFamily, publicFamily)
    .replaceAll("./files/", "/fonts/");
}

// Onest for the text, Unbounded for the few display lines; both carry Cyrillic.
const FONT_CSS = [
  loadFontPackageCss("@fontsource-variable/onest", "Onest Variable", "Onest"),
  loadFontPackageCss("@fontsource-variable/unbounded", "Unbounded Variable", "Unbounded"),
].join("\n");

/*
 * The page: src/dashboard.html, plain HTML with its CSS and script inline.
 * It used to be a template literal right here, where a stray backtick or an
 * unescaped backslash blanked the whole page and tsc said nothing.
 */
const PAGE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "dashboard.html"), "utf8");

/* ------------------------------------------------------------------ */
/* Server                                                             */
/* ------------------------------------------------------------------ */

/**
 * One page of the stored feed as the Search tab shows it: cut to the date
 * window, without hidden jobs (unless asked), with my screening rules applied
 * against the funnel and the hidden list as they are right now.
 */
function feedView(sources: readonly SourceName[], hoursOld: number | undefined, includeDismissed: boolean) {
  const result = storedFeed(sources);

  // Narrower windows are cut from the stored month before the page limit, so
  // fresh jobs are ranked against each other, as a dedicated search would.
  // Postings with no date stay; the page decides about those.
  const windowStart = Date.now() - (hoursOld ?? SEARCH_DEFAULTS.hoursOld) * 3_600_000;
  const inWindow = result.jobs.filter((job) => !job.postedAt || Date.parse(job.postedAt) >= windowStart);

  // Read on every request, so dismissals written by the MCP or funnel.mjs
  // while the page is open apply at once.
  const dismissedKeys = new Set(listDismissedKeys());
  const keyed = inWindow.map((job) => ({ job, key: jobKey(job.url) }));
  const kept = includeDismissed ? keyed : keyed.filter(({ key }) => !dismissedKeys.has(key));

  // Rule hits stay in the payload with their reason; the page keeps them
  // behind the "скрыто правилами" toggle.
  const context = buildContext(listApplications(), listDismissed());
  const screened = screenAll(
    kept.map(({ job, key }) => ({ ...job, key, dismissed: dismissedKeys.has(key) })),
    context,
  );
  const page = screened.slice(0, SEARCH_DEFAULTS.limit);
  const hiddenByRules: Record<string, number> = {};
  const levelCounts: Record<string, number> = {};
  for (const row of page) {
    if (row.bucket === "dismiss") hiddenByRules[row.reason] = (hiddenByRules[row.reason] ?? 0) + 1;
    levelCounts[row.job.eligibility.level] = (levelCounts[row.job.eligibility.level] ?? 0) + 1;
  }
  return {
    result,
    page,
    hiddenByRules,
    levelCounts,
    dismissedCount: dismissedKeys.size,
    hiddenForDismissed: keyed.length - kept.length,
  };
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

/*
 * There is no login (a single-user tool on a trusted network), so the browser
 * is the thing to guard against: any web page you visit can send requests to
 * localhost. Measured before this: a cross-site POST with a text/plain body
 * wrote a dismissal and changed an application's status. Three checks:
 *
 *   - Host must be this machine (localhost, a private LAN address, its own
 *     name). A DNS-rebinding page arrives with its own domain as Host.
 *   - Writes must be application/json. A cross-site page can only send JSON
 *     after a CORS preflight, which this server never approves.
 *   - Writes that carry an Origin must come from this same host.
 *
 * Phones on the Wi-Fi (Job Hunt.bat binds 0.0.0.0) keep working: their Host is
 * the LAN address and their page is served from it.
 */
const PRIVATE_HOST = /^(localhost|127(?:\.\d+){3}|\[?::1\]?|10(?:\.\d+){3}|192\.168(?:\.\d+){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d+){2})$/i;
const MACHINE_NAMES = new Set([hostname().toLowerCase(), `${hostname().toLowerCase()}.local`]);

function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return PRIVATE_HOST.test(name) || MACHINE_NAMES.has(name);
}

function writeRejection(request: IncomingMessage): string | null {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const type = String(request.headers["content-type"] ?? "").toLowerCase();
  if (!type.startsWith("application/json")) return "writes must be application/json";
  const origin = request.headers.origin;
  if (origin) {
    let originHost = "";
    try {
      originHost = new URL(origin).host.toLowerCase();
    } catch {
      return "bad Origin";
    }
    if (originHost !== String(request.headers.host ?? "").toLowerCase()) return "cross-origin write refused";
  }
  return null;
}

/** A request from this machine, not from a phone on the Wi-Fi: for things that open windows here. */
function fromThisComputer(request: IncomingMessage): boolean {
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "");
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? HOST}`);
  const path = url.pathname;

  if (!hostAllowed(request.headers.host)) {
    sendJson(response, 403, { error: "unexpected Host header" });
    return;
  }
  const rejection = writeRejection(request);
  if (rejection) {
    sendJson(response, rejection.startsWith("writes") ? 415 : 403, { error: rejection });
    return;
  }

  try {
    if (request.method === "GET" && (path === "/" || path === "/index.html")) {
      // STATUSES is injected so the dropdown can never drift from the DB vocabulary.
      // All of them: the page's own header comment names the placeholders too.
      const html = PAGE.replaceAll("__STATUSES__", JSON.stringify(STATUSES)).replaceAll(
        "__SOURCES__",
        JSON.stringify(SEARCH_DEFAULTS.sources),
      );
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(html);
      return;
    }

    if (request.method === "GET" && path === "/fonts.css") {
      response.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Content-Length": Buffer.byteLength(FONT_CSS),
        "Cache-Control": "public, max-age=86400",
      });
      response.end(FONT_CSS);
      return;
    }

    if (request.method === "GET" && path.startsWith("/fonts/")) {
      const font = FONT_FILES.get(decodeURIComponent(path.slice("/fonts/".length)));
      if (font) {
        response.writeHead(200, {
          "Content-Type": "font/woff2",
          "Content-Length": font.length,
          "Cache-Control": "public, max-age=31536000, immutable",
        });
        response.end(font);
        return;
      }
    }

    if (request.method === "GET" && path === "/api/stats") {
      const staleDays = Number(url.searchParams.get("staleDays") ?? DEFAULT_STALE_DAYS);
      const stats = getStats({
        staleDays: Number.isFinite(staleDays) && staleDays > 0 ? staleDays : DEFAULT_STALE_DAYS,
      });
      sendJson(response, 200, { ...stats, dbPath: resolveDbPath() });
      return;
    }

    /*
     * New postings since the Search tab was last opened, counted the way the
     * tab shows them (default boards, month window, minus hidden, applied and
     * rule hits). Polled with the stats, for the "(N)" in the page title.
     * Never fetches: it only reads what the background refresh stored.
     */
    // `?since=<iso>` counts from another moment instead — the desktop app asks
    // "since my last notification" and "in the last 24 hours". `top` names the
    // first few, best-ranked first, for the notification text.
    if (request.method === "GET" && path === "/api/new-count") {
      const sinceParam = url.searchParams.get("since");
      const since =
        sinceParam && !Number.isNaN(Date.parse(sinceParam))
          ? new Date(sinceParam).toISOString()
          : getMeta(LAST_VISIT);
      // Claude's "skip" is hidden on the page, so it is not news either; a
      // posting Claude liked goes first in `top`, marked. `pending`: how many
      // of them Claude is about to judge, and since when — the tray app waits
      // for those before it says "N новых", so a skip is not announced first.
      const sources = [...SEARCH_DEFAULTS.sources];
      const stored = sources.some((source) => lastFetch(source).lastSuccessAt !== null);
      const verdicts = verdictViews();
      const rank: Record<string, number> = { apply: 0, maybe: 1 };
      const verdictRank = (key: string) => rank[verdicts.get(key)?.verdict ?? ""] ?? 2;
      const fresh =
        since === null || !stored
          ? []
          : feedView(sources, undefined, false).page.filter(
              ({ job, bucket }) =>
                (bucket === "apply" || bucket === "check" || bucket === "needs-you") &&
                (job.firstSeenAt ?? "") > since &&
                verdicts.get(job.key)?.verdict !== "skip",
            );
      const mark = { apply: "✓ ", maybe: "? " } as Record<string, string>;
      const pending = fresh.filter(
        ({ job }) => !verdicts.has(job.key) && verdictPending(job.key, job.firstSeenAt ?? null),
      );
      sendJson(response, 200, {
        count: fresh.length,
        pending: pending.length,
        pendingSince: pending.map(({ job }) => job.firstSeenAt ?? "").sort()[0] || null,
        since,
        top: [...fresh]
          .sort((a, b) => verdictRank(a.job.key) - verdictRank(b.job.key))
          .slice(0, 3)
          .map(({ job }) => `${mark[verdicts.get(job.key)?.verdict ?? ""] ?? ""}${job.company} — ${job.title}`),
        refreshing: refreshing(),
      });
      return;
    }

    /*
     * Claude's verdict on one card (src/verdict.ts): queued now, answered in
     * ~10–20 s; the page polls GET /api/verdicts for it. The job is looked up
     * in the stored feed the card came from, then among all stored postings.
     */
    if (request.method === "POST" && path === "/api/verdict") {
      const body = JSON.parse((await readBody(request)) || "{}") as Record<string, unknown>;
      const key = typeof body["key"] === "string" ? body["key"] : "";
      const shown = storedFeed(SEARCH_DEFAULTS.sources).jobs.find((candidate) => jobKey(candidate.url) === key);
      const copies = [...(shown ? [shown] : []), ...findPostings(key)];
      if (copies.length === 0) {
        sendJson(response, 404, { error: "no such job in the stored postings" });
        return;
      }
      requestVerdict(key, copies, "manual");
      sendJson(response, 202, { status: verdictStatus() });
      return;
    }

    // Verdicts made after `since`, and what the queue is doing. `now` is the
    // next call's `since`; it is taken before the read so nothing falls between.
    if (request.method === "GET" && path === "/api/verdicts") {
      const now = new Date().toISOString();
      const sinceParam = url.searchParams.get("since");
      const since =
        sinceParam && !Number.isNaN(Date.parse(sinceParam)) ? new Date(sinceParam).toISOString() : undefined;
      sendJson(response, 200, {
        verdicts: Object.fromEntries(verdictViews(since)),
        status: verdictStatus(),
        now,
      });
      return;
    }

    // Настройки → Claude: what the verdict queue runs with, and how much of today's cap is used.
    if (request.method === "GET" && path === "/api/settings") {
      sendJson(response, 200, { claude: { ...claudeSettings(), runsToday: autoRunsToday(), defaults: defaultClaudeSettings() } });
      return;
    }

    if (request.method === "POST" && path === "/api/settings/claude") {
      const body = JSON.parse((await readBody(request)) || "{}") as Record<string, unknown>;
      let saved;
      try {
        saved = saveClaudeSettings(body);
      } catch (error) {
        sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      // Switched on, or the cap raised: take what is waiting now, not at the next tick.
      queueVerdicts();
      sendJson(response, 200, { claude: { ...saved, runsToday: autoRunsToday(), defaults: defaultClaudeSettings() } });
      return;
    }

    /*
     * "Оценить оставшиеся сейчас": every card the Search tab shows that has no
     * verdict under the current criteria, queued as asked by hand — past the
     * daily cap, which is for the background, not for me.
     */
    if (request.method === "POST" && path === "/api/verdicts/queue") {
      const verdicts = verdictViews();
      const waiting = shownJobs().filter(({ job }) => {
        const verdict = verdicts.get(job.key);
        return !verdict || verdict.stale;
      });
      for (const { job } of waiting) requestVerdict(job.key, [job, ...findPostings(job.key)], "manual");
      sendJson(response, 202, { queued: waiting.length, status: verdictStatus() });
      return;
    }

    /*
     * "обсудить в Claude": the verdict's own session, opened in Claude Desktop
     * (or a console running `claude --resume`). On this computer only — that
     * is where the window opens.
     */
    if (request.method === "POST" && path === "/api/verdict/open") {
      if (!fromThisComputer(request)) {
        sendJson(response, 403, { error: "Claude открывается только на этом компьютере" });
        return;
      }
      const body = JSON.parse((await readBody(request)) || "{}") as Record<string, unknown>;
      const row = getVerdict(typeof body["key"] === "string" ? body["key"] : "");
      if (!row?.session_id) {
        sendJson(response, 404, { error: "у этой вакансии нет оценки Claude" });
        return;
      }
      try {
        sendJson(response, 200, { opened: await openSession(row.session_id) });
      } catch (error) {
        sendJson(response, error instanceof SessionGone ? 410 : 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    // apply.mjs reports every outcome short of "applied".
    if (request.method === "POST" && path === "/api/attempts") {
      const body = JSON.parse((await readBody(request)) || "{}") as Record<string, unknown>;
      const text = (value: unknown): string | null =>
        typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
      const attemptUrl = text(body["url"]);
      const result = text(body["result"]);
      if (!attemptUrl || !result) {
        sendJson(response, 400, { error: "url and result are required" });
        return;
      }
      recordAttempt({
        url: attemptUrl,
        applyUrl: text(body["applyUrl"]),
        company: text(body["company"]),
        title: text(body["title"]),
        result,
        detail: text(body["detail"]),
        screenshot: text(body["screenshot"]),
      });
      sendJson(response, 201, { ok: true });
      return;
    }

    /*
     * "Подать" on a card: run scripts/apply.mjs for it (src/apply-runner.ts).
     * Only from this machine — Chrome opens here, and the Greenhouse code is
     * typed here — and only as dry run first; the runner refuses a submit that
     * was not preceded by one.
     */
    if (request.method === "POST" && path === "/api/apply") {
      if (!fromThisComputer(request)) {
        sendJson(response, 403, { error: "applications start only from this computer" });
        return;
      }
      const body = JSON.parse((await readBody(request)) || "{}") as Record<string, unknown>;
      const key = typeof body["key"] === "string" ? body["key"] : "";
      const mode = body["mode"] === "submit" ? "submit" : "dry-run";
      const job = storedFeed(SEARCH_DEFAULTS.sources).jobs.find((candidate) => jobKey(candidate.url) === key);
      if (!job) {
        sendJson(response, 404, { error: "no such job in the stored postings" });
        return;
      }
      const refused = refusal(key, job, mode, body["acceptLowPay"] === true);
      if (refused) {
        sendJson(response, 409, { error: refused.message, lowPay: refused.lowPay ?? false });
        return;
      }
      const run = startApply(key, job, mode, `http://127.0.0.1:${PORT}`);
      sendJson(response, 202, { id: run.id, mode, profile: run.profile });
      return;
    }

    const applyRunMatch = path.match(/^\/api\/apply\/([0-9a-f-]{36})$/);
    if (request.method === "GET" && applyRunMatch) {
      const run = getRun(applyRunMatch[1] as string);
      if (!run) {
        sendJson(response, 404, { error: "no such run" });
        return;
      }
      sendJson(response, 200, run);
      return;
    }

    // Open attempts: the "нужно вам" list on the Search tab.
    if (request.method === "GET" && path === "/api/attempts") {
      sendJson(response, 200, { attempts: listOpenAttempts() });
      return;
    }

    // The Search tab was opened: what is there now is no longer "new".
    if (request.method === "POST" && path === "/api/visit") {
      const previous = getMeta(LAST_VISIT);
      setMeta(LAST_VISIT, new Date().toISOString());
      sendJson(response, 200, { previous });
      return;
    }

    if (request.method === "GET" && path === "/api/applications") {
      const statusParam = url.searchParams.get("status");
      const staleDays = Number(url.searchParams.get("staleDays") ?? DEFAULT_STALE_DAYS);
      const status =
        statusParam && (STATUSES as readonly string[]).includes(statusParam)
          ? (statusParam as Status)
          : undefined;

      sendJson(response, 200, {
        applications: listApplications({
          status,
          staleDays: Number.isFinite(staleDays) && staleDays > 0 ? staleDays : DEFAULT_STALE_DAYS,
        }),
      });
      return;
    }

    /**
     * Search runs SERVER-SIDE on purpose: some feeds send no CORS headers, and
     * this reuses the same rate-limit-safe pipeline the MCP tool uses.
     */
    /**
     * Profile-driven search. No query parameters by design: what to look for
     * lives in src/profile.ts, so the UI is a single Refresh button.
     *
     * Runs SERVER-SIDE because some feeds send no CORS headers, and this reuses
     * the same rate-limit-safe pipeline the MCP tool uses.
     */
    if (request.method === "GET" && path === "/api/search") {
      // `includeDismissed` re-runs the same search without the "not interested"
      // filter, so hidden jobs can be reviewed and restored.
      const includeDismissed = ["1", "true", "on", "yes"].includes(
        (url.searchParams.get("includeDismissed") ?? "").toLowerCase(),
      );
      // The page's date chips. Narrower than the profile window only — a larger
      // value is ignored, so the URL cannot widen what the profile asked for.
      /*
       * Which boards to query. Intersected with the profile's own list, so the
       * parameter can only narrow the search — a hand-written URL cannot make
       * the dashboard scrape a board the profile never chose. An empty or
       * unrecognised value falls back to all of them rather than to nothing.
       */
      const askedFor = (url.searchParams.get("sources") ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name.length > 0);
      const chosen = SEARCH_DEFAULTS.sources.filter((source) => askedFor.includes(source));
      const sources = chosen.length > 0 ? chosen : [...SEARCH_DEFAULTS.sources];

      const hoursOldRaw = Number(url.searchParams.get("hoursOld"));
      const hoursOld =
        Number.isFinite(hoursOldRaw) && hoursOldRaw > 0
          ? Math.min(hoursOldRaw, SEARCH_DEFAULTS.hoursOld)
          : undefined;

      const forceRefresh = ["1", "true", "on", "yes"].includes(
        (url.searchParams.get("refresh") ?? "").toLowerCase(),
      );
      if (forceRefresh) {
        await refreshDue({ force: true, sources });
        // What the refresh found is judged now, not at the next 2-minute tick.
        queueVerdicts();
      } else await ensureStored(sources);
      const view = feedView(sources, hoursOld, includeDismissed);
      // Before the read, as in /api/verdicts: the page polls from here on.
      const verdictsAt = new Date().toISOString();
      const verdicts = verdictViews();

      sendJson(response, 200, {
        // `key` is the job's identity (src/jobkey.ts): the page compares it with
        // the funnel's url_key. `dismissed` renders a restore button.
        jobs: view.page.map(({ job, bucket, reason, flags }) => ({
          ...presentJob(job),
          key: job.key,
          dismissed: job.dismissed,
          screen: { bucket, reason, flags },
          // Claude's verdict (src/verdict.ts), null until there is one.
          verdict: verdicts.get(job.key) ?? null,
        })),
        claude: { ...verdictStatus(), now: verdictsAt },
        dismissedCount: view.dismissedCount,
        sourceCounts: view.result.sourceCounts,
        reports: view.result.reports,
        counts: {
          ...view.result.counts,
          hiddenForDismissed: view.hiddenForDismissed,
          hiddenByRules: view.hiddenByRules,
          returned: view.page.length,
        },
        levelCounts: view.levelCounts,
        // How old each board's data is, and whether a refresh is running now.
        freshness: freshness(sources),
        // Postings first seen after this are "new" (see POST /api/visit).
        newSince: getMeta(LAST_VISIT),
        // Echo the profile so the page can show what it searched for.
        profile: {
          queries: TARGET_QUERIES,
          location: SEARCH_DEFAULTS.location,
          remoteOnly: SEARCH_DEFAULTS.remoteOnly,
          hoursOld: hoursOld ?? SEARCH_DEFAULTS.hoursOld,
          sources,
        },
      });
      return;
    }

    // Add a job (typically straight from search) to the funnel.
    if (request.method === "POST" && path === "/api/applications") {
      const raw = await readBody(request);

      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw || "{}") as Record<string, unknown>;
      } catch {
        sendJson(response, 400, { error: "body must be valid JSON" });
        return;
      }

      const text = (value: unknown): string | null =>
        typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

      const url_ = text(body["url"]);
      const title = text(body["title"]);
      const company = text(body["company"]);
      if (!url_ || !title || !company) {
        sendJson(response, 400, { error: "url, title and company are required" });
        return;
      }

      const statusRaw = text(body["status"]);
      // Default 'applied': pressing "В воронку" means the application is sent.
      const status =
        statusRaw && (STATUSES as readonly string[]).includes(statusRaw)
          ? (statusRaw as Status)
          : ("applied" as Status);

      const { application, alreadyExisted } = insertApplication({
        company,
        title,
        url: url_,
        source: text(body["source"]) ?? "manual",
        location: text(body["location"]),
        salary: text(body["salary"]),
        status,
        // apply.mjs records what went out (CV version, cover letter, route), so
        // reply rates can later be compared per variant.
        notes: text(body["notes"]),
        postedAt: text(body["postedAt"]),
      });
      // Applied to: a verdict still waiting in the queue is not needed any more.
      dropQueued(jobKey(url_));

      // Re-adding is a no-op, not an error — the UI shows "already in funnel".
      sendJson(response, alreadyExisted ? 200 : 201, {
        application,
        result: alreadyExisted ? "already_tracked" : "inserted",
      });
      return;
    }

    // Hide a job from every future search (dashboard and find_jobs alike).
    if (request.method === "POST" && path === "/api/dismissed") {
      const raw = await readBody(request);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw || "{}") as Record<string, unknown>;
      } catch {
        sendJson(response, 400, { error: "body must be valid JSON" });
        return;
      }

      const text = (value: unknown): string | null =>
        typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

      const jobUrl = text(body["url"]);
      if (!jobUrl) {
        sendJson(response, 400, { error: "url is required" });
        return;
      }

      const { dismissed, alreadyHidden } = dismissJob({
        url: jobUrl,
        company: text(body["company"]),
        title: text(body["title"]),
        reason: text(body["reason"]),
      });
      dropQueued(jobKey(jobUrl));
      sendJson(response, alreadyHidden ? 200 : 201, {
        dismissed,
        result: alreadyHidden ? "already_hidden" : "hidden",
      });
      return;
    }

    // Restore a hidden job.
    if (request.method === "DELETE" && path === "/api/dismissed") {
      const raw = await readBody(request);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw || "{}") as Record<string, unknown>;
      } catch {
        sendJson(response, 400, { error: "body must be valid JSON" });
        return;
      }
      const jobUrl = typeof body["url"] === "string" ? body["url"].trim() : "";
      if (jobUrl.length === 0) {
        sendJson(response, 400, { error: "url is required" });
        return;
      }
      sendJson(response, 200, { restored: undismissJob(jobUrl) });
      return;
    }

    if (request.method === "GET" && path === "/api/dismissed") {
      sendJson(response, 200, { dismissed: listDismissed() });
      return;
    }

    const statusRoute = path.match(/^\/api\/applications\/(\d+)\/status$/);
    if (request.method === "POST" && statusRoute) {
      const id = Number(statusRoute[1]);
      const raw = await readBody(request);

      let parsed: { status?: unknown; responseAt?: unknown };
      try {
        parsed = JSON.parse(raw || "{}") as typeof parsed;
      } catch {
        sendJson(response, 400, { error: "body must be valid JSON" });
        return;
      }

      const status = String(parsed.status ?? "");
      if (!(STATUSES as readonly string[]).includes(status)) {
        sendJson(response, 400, { error: `status must be one of: ${STATUSES.join(", ")}` });
        return;
      }

      const responseAt =
        typeof parsed.responseAt === "string" && parsed.responseAt.length > 0
          ? parsed.responseAt
          : undefined;

      const application = updateStatus(id, status as Status, responseAt);
      if (!application) {
        sendJson(response, 404, { error: `no application with id ${id}` });
        return;
      }
      sendJson(response, 200, { application });
      return;
    }

    sendJson(response, 404, { error: `no route for ${request.method} ${path}` });
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Job Hunt dashboard  →  http://localhost:${PORT}`);
  console.log(`Listening on         →  ${HOST}:${PORT}`);
  console.log(`Reading database     →  ${resolveDbPath()}`);

  /*
   * Keep the postings table current while the dashboard runs: whatever is due
   * at start, then a check every 15 minutes (src/refresh.ts decides per board
   * — fast boards every 6 h, LinkedIn daily). A search never waits for this,
   * except the very first one on an empty table. JOBHUNT_BACKGROUND=0 turns
   * the schedule off; searches then fill the table on demand.
   */
  if (process.env["JOBHUNT_BACKGROUND"] !== "0") {
    const tick = () => {
      refreshDue()
        .then((outcomes) => {
          for (const outcome of outcomes) {
            if (outcome.status === "fetched" || outcome.status === "failed") {
              console.log(`refresh  ${describe(outcome)}`);
            }
          }
          queueVerdicts();
        })
        .catch((error: unknown) => {
          console.error(`Refresh failed: ${error instanceof Error ? error.message : error}`);
        });
    };
    tick();
    setInterval(tick, 15 * 60_000);
  }
  // Also on a timer of its own: the queue's daily cap and a usage limit end
  // between refreshes, and a scheduled `npm run refresh` fills the store too.
  setInterval(queueVerdicts, 2 * 60_000);
});

/*
 * Claude's verdicts for the cards the Search tab shows by default (default
 * boards, month window, nothing hidden, applied or hit by a rule): what
 * src/verdict.ts queues in the background. JOBHUNT_CLAUDE_AUTO=0 turns it off.
 */
function queueVerdicts(): void {
  try {
    queueShown(shownJobs().map(({ job }) => ({ key: job.key, job })));
  } catch (error) {
    console.error(`Verdict queue failed: ${error instanceof Error ? error.message : error}`);
  }
}

/** The cards the Search tab shows by default; nothing before the first board has been stored. */
function shownJobs() {
  const sources = [...SEARCH_DEFAULTS.sources];
  if (!sources.some((source) => lastFetch(source).lastSuccessAt !== null)) return [];
  return feedView(sources, undefined, false).page.filter(
    ({ job, bucket }) => !job.dismissed && (bucket === "apply" || bucket === "check" || bucket === "needs-you"),
  );
}

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Set JOBHUNT_PORT to something else, e.g. JOBHUNT_PORT=4322 npm run dashboard`,
    );
    process.exit(1);
  }
  throw error;
});
