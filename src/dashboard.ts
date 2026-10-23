/**
 * dashboard.ts — local read/write view of the same SQLite file the MCP uses.
 *
 * node:http, no build step. Binds to localhost by default; JOBHUNT_HOST can
 * expose it to the local network when launched by the Windows app.
 *
 * Form controls come from Pico CSS, served from node_modules at /pico.css — the
 * conditional build, so its rules only apply inside `.pico`. That keeps it to
 * the toolbar rather than restyling the cards, funnel and table this file
 * already draws. Its palette is remapped to the page's own variables below.
 * Nothing is fetched off this machine.
 */

import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import {
  DEFAULT_STALE_DAYS,
  STATUSES,
  dismissJob,
  getStats,
  insertApplication,
  listApplications,
  listDismissed,
  listDismissedKeys,
  resolveDbPath,
  undismissJob,
  updateStatus,
  type Status,
} from "./db.ts";
import { jobKey } from "./jobkey.ts";
import { presentJob, searchForProfile } from "./pipeline.ts";
import { buildContext, screenAll } from "./screening.ts";
import { SEARCH_DEFAULTS, TARGET_QUERIES } from "./profile.ts";

const PORT = Number(process.env["JOBHUNT_PORT"] ?? 4321);
const HOST = process.env["JOBHUNT_HOST"]?.trim() || "127.0.0.1";
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_SEARCH_CACHE_MINUTES = 60;
const configuredSearchCacheMinutes = Number(
  process.env["JOBHUNT_SEARCH_CACHE_MINUTES"] ?? DEFAULT_SEARCH_CACHE_MINUTES,
);
const SEARCH_CACHE_TTL_MS = 60_000 * (
  Number.isFinite(configuredSearchCacheMinutes) && configuredSearchCacheMinutes > 0
    ? configuredSearchCacheMinutes
    : DEFAULT_SEARCH_CACHE_MINUTES
);

type SearchResult = Awaited<ReturnType<typeof searchForProfile>>;

type SearchCacheEntry = {
  createdAt: number;
  result: Promise<SearchResult>;
  /** Set once the search has finished, so an expired entry can still be served. */
  value?: SearchResult;
  /** A background refresh of an expired entry, so only one runs at a time. */
  refreshing?: Promise<unknown>;
};

/**
 * Server-owned rather than browser-owned: page reloads share it, concurrent
 * identical searches share the same promise, and API responses can remain
 * `no-store` so a browser never serves stale application/dismissal state.
 *
 * The key is only which boards were asked. The dismissed list and the date
 * window used to be part of it, so every "скрыть" and every date chip made the
 * next search re-scrape every board — about 80 s with LinkedIn. Entries now
 * hold the whole ranked month, hidden jobs included, and /api/search cuts the
 * window and drops the hidden ones per request.
 */
const searchCache = new Map<string, SearchCacheEntry>();

function startSearch(overrides: Parameters<typeof searchForProfile>[0]): SearchCacheEntry {
  const entry: SearchCacheEntry = { createdAt: Date.now(), result: searchForProfile(overrides) };
  entry.result.then(
    (value) => {
      entry.value = value;
    },
    () => {},
  );
  return entry;
}

async function cachedProfileSearch(
  key: string,
  overrides: Parameters<typeof searchForProfile>[0],
  forceRefresh: boolean,
): Promise<{ result: SearchResult; hit: boolean; ageMs: number; stale: boolean }> {
  const now = Date.now();
  const existing = searchCache.get(key);
  if (!forceRefresh && existing) {
    const ageMs = now - existing.createdAt;
    if (ageMs < SEARCH_CACHE_TTL_MS) {
      return { result: await existing.result, hit: true, ageMs, stale: false };
    }
    // Expired but finished: answer with it now and refresh behind the scenes,
    // rather than making the page wait a full pass because an hour went by.
    if (existing.value) {
      if (!existing.refreshing) {
        const next = startSearch(overrides);
        existing.refreshing = next.result.then(
          () => searchCache.set(key, next),
          () => {
            existing.refreshing = undefined;
          },
        );
      }
      return { result: existing.value, hit: true, ageMs, stale: true };
    }
  }

  const entry = startSearch(overrides);
  searchCache.set(key, entry);
  try {
    return { result: await entry.result, hit: false, ageMs: 0, stale: false };
  } catch (error) {
    // A transient board failure must not poison every request for the next hour.
    if (searchCache.get(key) === entry) searchCache.delete(key);
    throw error;
  }
}

/**
 * The cached feed is not sliced: hidden jobs are removed per request, and the
 * page's own limit applies after that. Any number above what a pass can return
 * works; oversample() in pipeline.ts caps the fetch size on its own.
 */
const FEED_LIMIT = 10_000;

function profileCacheKey(sources: readonly string[]): string {
  return JSON.stringify({ sources: [...sources].sort() });
}

/**
 * Read once at boot rather than per request. A missing file means a broken
 * install, and failing here says so plainly instead of serving an unstyled page.
 */
const localRequire = createRequire(import.meta.url);
const PICO_CSS = readFileSync(
  localRequire.resolve("@picocss/pico/css/pico.conditional.min.css"),
  "utf8",
);

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

const FONT_CSS = [
  loadFontPackageCss(
    "@fontsource-variable/space-grotesk",
    "Space Grotesk Variable",
    "Space Grotesk",
  ),
  loadFontPackageCss(
    "@fontsource-variable/plus-jakarta-sans",
    "Plus Jakarta Sans Variable",
    "Plus Jakarta Sans",
  ),
].join("\n");

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job Hunt</title>
<link rel="stylesheet" href="/fonts.css">
<link rel="stylesheet" href="/pico.css">
<style>
  /*
   * Pico's palette, remapped onto this page's variables. Without this the
   * toolbar renders in Pico's own blue-grey and reads as a foreign widget
   * dropped onto the page. Only the tokens the toolbar actually uses.
   */
  .pico {
    --pico-font-family: inherit;
    --pico-font-size: 13px;
    --pico-line-height: 1.45;
    --pico-border-radius: 6px;
    --pico-spacing: 12px;
    --pico-form-element-spacing-vertical: 7px;
    --pico-form-element-spacing-horizontal: 11px;
    --pico-background-color: var(--panel);
    --pico-color: var(--text);
    --pico-h1-color: var(--text);
    --pico-muted-color: var(--muted);
    --pico-muted-border-color: var(--line);
    --pico-primary: var(--accent);
    --pico-primary-background: var(--accent);
    --pico-primary-border: var(--accent);
    --pico-primary-hover-background: var(--accent);
    --pico-primary-hover-border: var(--accent);
    --pico-primary-underline: transparent;
    --pico-primary-focus: color-mix(in srgb, var(--accent) 35%, transparent);
    --pico-primary-inverse: #fff;
    --pico-form-element-background-color: var(--panel-2);
    --pico-form-element-border-color: var(--line);
    --pico-form-element-color: var(--text);
    --pico-form-element-focus-color: var(--accent);
    --pico-switch-background-color: var(--line);
    --pico-switch-checked-background-color: var(--accent);
  }

  :root {
    color-scheme: light dark;
    --font-sans: "Space Grotesk", "Plus Jakarta Sans", "Segoe UI", sans-serif;
    --bg: #0b0f17;
    --panel: #121824;
    --panel-2: #192231;
    --panel-3: #202b3c;
    --line: #263246;
    --text: #f0f4fb;
    --muted: #8e9bb0;
    --accent: #75a7ff;
    --accent-soft: color-mix(in srgb, var(--accent) 13%, transparent);
    --warn: #f4b15f;
    --bad: #f17878;
    --good: #62d99c;
    --shadow: 0 16px 40px rgba(0, 0, 0, .16);
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f4f6fa; --panel: #fff; --panel-2: #f1f4f8; --panel-3: #e8edf5;
      --line: #dce3ed; --text: #172033; --muted: #68758a; --accent: #326fd1;
      --warn: #a4601a; --bad: #b83d3d; --good: #1d7a50;
      --shadow: 0 16px 40px rgba(30, 49, 78, .08);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0 24px 64px; min-height: 100vh; min-height: 100dvh;
    background:
      radial-gradient(circle at 50% -240px, color-mix(in srgb, var(--accent) 12%, transparent), transparent 520px),
      var(--bg); color: var(--text);
    font: 14px/1.5 var(--font-sans);
  }
  button, input, select { font-family: inherit; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .wrap { max-width: 1440px; margin: 0 auto; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 20px;
           min-height: 88px; }
  .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .brandmark { display: grid; place-items: center; width: 38px; height: 38px; flex: 0 0 auto;
               border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--line));
               border-radius: 11px; color: var(--accent); background: var(--accent-soft);
               font-size: 17px; font-weight: 700; letter-spacing: -.04em; }
  .brandcopy { min-width: 0; }
  h1 { font-size: 19px; line-height: 1.2; margin: 0 0 3px; letter-spacing: -0.02em; }
  .sub { color: var(--muted); font-size: 12.5px; }
  .sub code { background: var(--panel-2); padding: 1px 5px; border-radius: 4px; }
  .contact-links { display: flex; align-items: center; gap: 7px; flex: 0 0 auto; }
  .copylink { display: inline-flex; align-items: center; justify-content: center; gap: 7px;
              min-height: 34px; margin: 0; padding: 7px 11px;
              border: 1px solid var(--line); border-radius: 8px;
              background: color-mix(in srgb, var(--panel) 88%, transparent); color: var(--muted);
              font: inherit; font-size: 11px; font-weight: 700; letter-spacing: .055em;
              cursor: pointer; transition: color .15s, border-color .15s, background .15s; }
  .copylink svg { width: 13px; height: 13px; flex: 0 0 auto; stroke: currentColor; }
  .copylink:hover { color: var(--text); border-color: var(--muted); background: var(--panel-2); }
  .copylink.is-copied { color: var(--good); border-color: var(--good);
                        background: color-mix(in srgb, var(--good) 9%, var(--panel)); }
  .cards { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
  .card { position: relative; overflow: hidden; min-height: 92px; background: var(--panel);
          border: 1px solid var(--line); border-radius: 14px; padding: 15px 16px; }
  .card:first-child { background: linear-gradient(135deg, var(--accent-soft), var(--panel) 72%);
                      border-color: color-mix(in srgb, var(--accent) 32%, var(--line)); }
  .card .k { color: var(--muted); font-size: 10.5px; font-weight: 650;
             text-transform: uppercase; letter-spacing: .09em; }
  .card .v { font-size: 25px; line-height: 1.15; font-weight: 650; margin-top: 9px;
             letter-spacing: -.03em; font-variant-numeric: tabular-nums; }
  .card .v small { display: inline-flex; align-items: center; margin-left: 3px;
                   font-size: 11.5px; font-weight: 600; letter-spacing: 0; color: var(--muted); }
  section.panel { background: color-mix(in srgb, var(--panel) 96%, transparent);
                  border: 1px solid var(--line); border-radius: 14px; padding: 18px;
                  margin-bottom: 16px; box-shadow: var(--shadow); }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .09em;
       color: var(--muted); margin: 0 0 12px; }
  .tracker-layout { display: grid; grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
                    gap: 16px; align-items: start; }
  .tracker-layout > .panel { margin-bottom: 0; }
  .funnel-panel { position: sticky; top: 16px; }
  .section-kicker { margin: 4px 0 0; color: var(--muted); font-size: 12.5px; }
  /* funnel */
  .funnel { display: flex; flex-direction: column; gap: 13px; margin-top: 20px; }
  .frow { display: grid; grid-template-columns: 80px 1fr 26px; align-items: center; gap: 9px; }
  .frow .fname { font-size: 12px; color: var(--muted); text-transform: capitalize; }
  .bar { height: 7px; background: var(--panel-2); border-radius: 999px; overflow: hidden; }
  .bar > i { display: block; min-width: 0; height: 100%; background: var(--accent);
             border-radius: 999px; transition: width .25s; }
  .frow[data-s="offer"] .bar > i { background: var(--good); }
  .frow[data-s="rejected"] .bar > i, .frow[data-s="ghosted"] .bar > i { background: var(--bad); }
  /* Walking away is not bad news from them — grey, not red. */
  .frow[data-s="dropped"] .bar > i { background: var(--muted); }
  .frow .fcount { text-align: right; font-variant-numeric: tabular-nums; font-size: 13px; }
  /* table */
  .tablewrap { overflow-x: auto; margin: 0 -18px -18px; border-radius: 0 0 14px 14px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 12px 14px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  th { background: color-mix(in srgb, var(--panel-2) 50%, var(--panel));
       font-size: 10.5px; text-transform: uppercase; letter-spacing: .08em;
       color: var(--muted); font-weight: 650; white-space: nowrap; }
  th:first-child, td:first-child { padding-left: 18px; }
  th:last-child, td:last-child { padding-right: 18px; }
  tbody tr:last-child td { border-bottom: 0; }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: var(--text); }
  th .arrow { opacity: .5; font-size: 10px; }
  tbody tr { transition: background .12s; }
  tbody tr:hover { background: color-mix(in srgb, var(--panel-2) 72%, transparent); }
  tr.is-ghosted { background: color-mix(in srgb, var(--bad) 9%, transparent); }
  tr.is-ghosted td:first-child { border-left: 3px solid var(--bad); }
  tr.needs-attention td:first-child { border-left: 3px solid var(--warn); }
  .company { max-width: 180px; font-weight: 650; }
  .title { min-width: 250px; }
  .title a { color: inherit; font-weight: 550; text-decoration: none; }
  .title a::after { content: "↗"; margin-left: 5px; color: var(--muted); font-size: 11px; }
  .title a:hover { color: var(--accent); }
  .meta { margin-top: 2px; color: var(--muted); font-size: 11.5px; }
  .nowrap { white-space: nowrap; font-variant-numeric: tabular-nums; }
  .age-pill { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); }
  .age-pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--line); }
  .age-pill.warm { color: var(--warn); }
  .age-pill.warm::before { background: var(--warn);
                           box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 14%, transparent); }
  select { background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
           border-radius: 6px; padding: 4px 6px; font: inherit; font-size: 12.5px; cursor: pointer; }
  /*
   * The dropdown IS the status display. There used to be a badge above it
   * saying the same word twice; colour carries that meaning now, and there is
   * one control instead of a label plus a control that can disagree.
   */
  select.status { min-width: 104px; font-weight: 600; text-transform: capitalize;
                  padding: 6px 28px 6px 9px; border-radius: 8px; }
  select.status:hover { border-color: var(--muted); }
  select.status[data-s="offer"] { color: var(--good); border-color: var(--good); }
  select.status[data-s="interview"], select.status[data-s="screening"] { color: var(--accent); border-color: var(--accent); }
  select.status[data-s="responded"] { color: var(--warn); border-color: var(--warn); }
  select.status[data-s="rejected"], select.status[data-s="ghosted"] { color: var(--bad); border-color: var(--bad); }
  select.status[data-s="dropped"] { color: var(--muted); border-style: dashed; }
  .empty { color: var(--muted); padding: 40px 18px; text-align: center; }
  .toast { position: fixed; right: 16px; bottom: 16px; background: var(--panel); border: 1px solid var(--line);
           border-radius: 8px; padding: 9px 14px; font-size: 13px; opacity: 0; transform: translateY(6px);
           transition: .18s; pointer-events: none; }
  .toast.show { opacity: 1; transform: none; }
  .toast.err { border-color: var(--bad); color: var(--bad); }

  /* tabs */
  .tabs { display: inline-flex; gap: 4px; margin-bottom: 18px; padding: 4px;
          border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
  .tab { background: none; border: 0; border-radius: 7px; color: var(--muted);
         font: inherit; font-weight: 600; font-size: 12.5px; padding: 7px 15px; cursor: pointer; }
  .tab:hover { color: var(--text); }
  .tab.is-active { color: var(--text); background: var(--panel-3); box-shadow: 0 1px 2px rgba(0,0,0,.16); }

  /*
   * Search toolbar: one row. Pico supplies the button and the switches, but its
   * defaults are sized for a full-page form — left alone, the five-option radio
   * group filled a line by itself. Everything below is toolbar sizing.
   */
  .searchform { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; margin: 0; }
  /* Pico stretches submit buttons to the form width, which is right for a
     signup form and wrong for a toolbar. Matching its specificity to undo it. */
  .searchform > button[type="submit"] { margin: 0; width: auto; flex: 0 0 auto;
                         padding: 7px 15px; font-size: 13px; font-weight: 600; }
  /* Pico gives fieldsets width:100%, which puts every group on its own row. */
  .searchform fieldset { margin: 0; padding: 0; border: 0; width: auto;
                         display: flex; align-items: center; gap: 8px; }
  .searchform legend { float: left; margin: 0 8px 0 0; padding: 0; font-size: 11px;
                       text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
  /* Kept for screen readers on groups whose controls already read as labelled. */
  .searchform legend.sr { position: absolute; width: 1px; height: 1px;
                          overflow: hidden; clip-path: inset(50%); white-space: nowrap; }

  /*
   * Segmented control. The inputs stay real radios — arrow-key navigation and
   * the screen-reader grouping come from the markup; this is only paint. Five
   * short, mutually exclusive options belong in one control you can read at a
   * glance, not in five separate radio dots.
   */
  .segwrap { display: inline-flex; border: 1px solid var(--line);
             border-radius: 6px; overflow: hidden; }
  .segwrap label { margin: 0; }
  .segwrap input { position: absolute; opacity: 0; width: 0; height: 0; margin: 0; }
  .segwrap span { display: block; padding: 6px 11px; font-size: 12.5px; line-height: 1.15;
                  color: var(--muted); cursor: pointer; border-left: 1px solid var(--line); }
  .segwrap label:first-child span { border-left: 0; }
  .segwrap label:hover span { background: var(--panel-2); color: var(--text); }
  .segwrap input:checked + span { background: var(--accent); color: #fff; font-weight: 600; }
  .segwrap input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: -2px; }

  /*
   * Source pills. Same visual language as the segmented control, but each one
   * is rounded and spaced on its own: these are independent toggles, and a
   * joined segment would promise a single choice.
   */
  .srcpills { display: inline-flex; gap: 6px; flex-wrap: wrap; }
  .srcpills label { margin: 0; }
  .srcpills input { position: absolute; opacity: 0; width: 0; height: 0; margin: 0; }
  /* Direct child only — the count inside must not pick up the pill's own box. */
  .srcpills label > span { display: block; padding: 6px 11px; font-size: 12.5px;
                   line-height: 1.15; white-space: nowrap;
                   color: var(--muted); cursor: pointer; border: 1px solid var(--line);
                   border-radius: 6px; }
  .srcpills label:hover > span { background: var(--panel-2); color: var(--text); }
  .srcpills input:checked + span { background: var(--accent); color: #fff;
                                   border-color: var(--accent); font-weight: 600; }
  .srcpills input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* Pico sizes a switch in em, so font-size is the only knob that shrinks it. */
  .toggles { gap: 14px !important; }
  .toggles label { margin: 0; display: inline-flex; align-items: center; gap: 6px;
                   font-size: 12.5px; color: var(--muted); cursor: pointer; white-space: nowrap; }
  .toggles label:hover, .toggles label:has(:checked) { color: var(--text); }
  .toggles [role="switch"] { font-size: 10px; margin: 0; flex: 0 0 auto; }
  .btn { background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 8px 16px;
         font: inherit; font-weight: 600; font-size: 13px; cursor: pointer; }
  .btn:hover { filter: brightness(1.08); }
  .btn[disabled] { opacity: .55; cursor: default; filter: none; }
  .btn.ghost { background: var(--panel-2); color: var(--text); border: 1px solid var(--line); }
  .btn.secondary { background: var(--panel-2); color: var(--muted); border: 1px solid var(--line); }
  .btn.secondary:hover { color: var(--text); border-color: var(--muted); filter: none; }
  .search-panel { padding: 20px !important; }
  .search-heading { display: flex; align-items: flex-start; justify-content: space-between;
                    gap: 20px; margin-bottom: 18px; }
  .search-heading h2 { margin-bottom: 0; color: var(--text); font-size: 15px;
                       text-transform: none; letter-spacing: -.01em; }
  .search-heading #searchbtn { flex: 0 0 auto; min-width: 116px; margin: 0; padding: 8px 14px;
                               border: 1px solid var(--accent); border-radius: 8px;
                               background: var(--accent); color: #fff; font: inherit;
                               font-size: 12.5px; font-weight: 650; cursor: pointer; }
  .search-heading #searchbtn:hover { filter: brightness(1.07); }
  .search-heading #searchbtn[disabled] { opacity: .65; cursor: wait; }
  .search-progress { margin-top: 16px; }
  .search-progress[hidden] { display: none; }
  .search-progress-track { position: relative; height: 4px; overflow: hidden;
                           border-radius: 999px; background: var(--panel-2); }
  .search-progress-bar { position: absolute; inset-block: 0; left: 0; width: 38%;
                         border-radius: inherit; background: var(--accent);
                         box-shadow: 0 0 12px color-mix(in srgb, var(--accent) 55%, transparent);
                         animation: search-sweep 1.2s ease-in-out infinite; }
  .search-progress-copy { display: flex; justify-content: space-between; gap: 12px;
                          margin-top: 7px; color: var(--muted); font-size: 11.5px; }
  .search-progress-copy span:last-child { font-variant-numeric: tabular-nums; }
  @keyframes search-sweep {
    from { transform: translateX(-115%); }
    to { transform: translateX(365%); }
  }

  .resultshead { display: flex; align-items: center; justify-content: space-between;
                 gap: 16px; margin: 22px 2px 13px; }
  .resulttitle { display: flex; align-items: baseline; gap: 10px; white-space: nowrap; }
  .resulttitle h2 { margin: 0; color: var(--text); font-size: 15px;
                    text-transform: none; letter-spacing: -.01em; }
  .resulttitle span { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  .resultfilters { display: flex; align-items: center; justify-content: flex-end; gap: 8px;
                   flex: 1 1 auto; }
  .jobsearchbox { width: min(360px, 100%); max-width: 360px; flex-basis: 280px; }
  .resultfilters select { height: 34px; min-width: 126px; padding: 5px 28px 5px 9px;
                          border-radius: 8px; }
  .view.is-loading .jobgrid { opacity: .42; pointer-events: none; }
  .view.is-loading .resultshead { opacity: .7; }

  /* job cards */
  .jobgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 13px;
             transition: opacity .18s; }
  .jobcard { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
             min-height: 270px; padding: 16px; display: flex; flex-direction: column; gap: 9px;
             position: relative; transition: transform .15s, border-color .15s, box-shadow .15s; }
  .jobcard:hover { transform: translateY(-2px); border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
                   box-shadow: 0 12px 28px rgba(0,0,0,.18); }
  .jobcard:hover h3 { color: var(--accent); }
  .jobcard .cardlink { position: absolute; inset: 0; z-index: 1; border-radius: inherit; }
  .jobcard .cardlink:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .jobcard.lvl-high { border-left: 3px solid var(--good); }
  .jobcard.lvl-medium { border-left: 3px solid var(--warn); }
  .jobcard h3 { margin: 3px 0 0; font-size: 15px; line-height: 1.38; letter-spacing: -.012em; }
  .jobcard .co { font-size: 13px; font-weight: 650; color: var(--text); }
  .jobcard .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .jobcard .details { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 9px;
                      min-height: 20px; color: var(--muted); font-size: 11.5px; }
  .jobcard .details span { display: inline-flex; align-items: center; gap: 4px; }
  .jobcard .reason { margin-top: 2px; padding: 9px 10px; border-radius: 8px;
                    background: color-mix(in srgb, var(--panel-2) 62%, transparent);
                    font-size: 11.5px; color: var(--muted); line-height: 1.5; }
  .jobcard .sal { color: var(--text); font-variant-numeric: tabular-nums; }
  .jobcard .sal.low { color: var(--warn); }
  .jobcard .actions { display: flex; gap: 8px; align-items: center; margin-top: auto; padding-top: 4px;
                      position: relative; z-index: 2; }
  .jobcard .actions .btn:first-child { flex: 1 1 auto; }
  .lvl { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px;
         font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .lvl.high { color: var(--good); border: 1px solid var(--good); }
  .lvl.medium { color: var(--warn); border: 1px solid var(--warn); }
  .src { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
  .fit { font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums;
         padding: 1px 6px; border-radius: 4px; background: var(--panel-2); color: var(--muted); }
  .fit.good { color: var(--good); }
  .fit.bad { color: var(--bad); }
  .geo { font-size: 11px; color: var(--muted); padding: 1px 6px; border-radius: 4px;
         border: 1px solid var(--line); }
  .geo.confirmed { color: var(--good); }
  .geo.check { color: var(--warn); }
  .linkbtn { background: none; border: 0; color: var(--muted); font: inherit; font-size: 12.5px;
             cursor: pointer; padding: 0; text-decoration: underline; text-underline-offset: 2px; }
  .linkbtn:hover { color: var(--bad); }
  .linkbtn.restore:hover { color: var(--good); }
  .jobcard.is-dismissed { opacity: .5; }
  .jobcard.is-rulehidden { opacity: .62; }
  .jobcard .sig { font-size: 10.5px; padding: 1px 6px; border-radius: 999px; color: var(--muted);
                  border: 1px solid var(--line); }
  .jobcard .sig.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); }
  .jobcard .rulehit { font-size: 11.5px; color: var(--warn); }
  .jobcard .flag { font-size: 11.5px; color: var(--muted); }
  .jobcard .hidewhy { position: relative; }
  .jobcard .hidewhy summary { list-style: none; cursor: pointer; padding: 4px 6px; color: var(--muted); }
  .jobcard .hidewhy summary::-webkit-details-marker { display: none; }
  .jobcard .hidewhy[open] > div { position: absolute; right: 0; bottom: calc(100% + 4px); z-index: 5;
                                  display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
                                  padding: 8px 10px; border-radius: 8px; white-space: nowrap;
                                  background: var(--panel-2); border: 1px solid var(--line); }
  .jobcard.is-applied { border-left-color: var(--accent); }
  .search-empty { display: flex; flex-direction: column; align-items: center; gap: 7px;
                  padding: 54px 20px; border: 1px dashed var(--line); border-radius: 14px;
                  background: color-mix(in srgb, var(--panel) 70%, transparent); }
  .search-empty[hidden] { display: none; }
  .search-empty .emptyicon { display: grid; place-items: center; width: 42px; height: 42px;
                             margin-bottom: 3px; border-radius: 12px; background: var(--panel-2);
                             color: var(--muted); font-size: 23px; }
  .search-empty strong { color: var(--text); font-size: 14px; }
  .search-empty span { margin-bottom: 7px; font-size: 12.5px; }
  /* Scroll sentinel: also the "how much is left" readout, and the manual
     fallback for when the observer is unavailable. */
  .loadmore { display: flex; flex-direction: column; align-items: center; gap: 8px;
              padding: 22px 0 6px; color: var(--muted); font-size: 12.5px; }
  .loadmore button { background: var(--panel-2); color: var(--text);
                     border: 1px solid var(--line); border-radius: 6px;
                     padding: 7px 18px; font: inherit; font-size: 12.5px; cursor: pointer; }
  .loadmore button:hover { border-color: var(--muted); }
  .jobcard .when { font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums;
                   margin-left: auto; }
  .panelhead { display: flex; align-items: center; justify-content: space-between;
               gap: 14px; margin-bottom: 16px; flex-wrap: wrap; }
  .panelhead h2 { margin: 0; }
  .paneltitle { min-width: 130px; }
  .filters { display: flex; align-items: center; justify-content: flex-end; gap: 8px;
             flex: 1 1 420px; font-size: 12.5px; color: var(--muted); }
  .searchbox { position: relative; flex: 1 1 230px; max-width: 360px; }
  .searchbox::before { content: "⌕"; position: absolute; left: 10px; top: 50%;
                       transform: translateY(-52%); color: var(--muted); font-size: 17px;
                       pointer-events: none; }
  .searchbox input { width: 100%; height: 34px; margin: 0; padding: 6px 10px 6px 31px;
                     border: 1px solid var(--line); border-radius: 8px;
                     background: var(--panel-2); color: var(--text); font-size: 12.5px; }
  .searchbox input::placeholder { color: var(--muted); }
  .filterlabel { position: absolute; width: 1px; height: 1px; overflow: hidden;
                 clip-path: inset(50%); white-space: nowrap; }

  @media (max-width: 1100px) {
    .cards { grid-template-columns: repeat(3, 1fr); }
    .tracker-layout { grid-template-columns: 1fr; }
    .funnel-panel { position: static; }
    .funnel { display: grid; grid-template-columns: 1fr 1fr; column-gap: 28px; }
  }
  @media (max-width: 720px) {
    body { padding: 0 14px 40px; }
    header { min-height: 76px; padding: 14px 0; flex-wrap: wrap; gap: 12px; }
    .brandmark { width: 34px; height: 34px; }
    .sub { display: block; max-width: 250px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .contact-links { width: 100%; }
    .copylink { flex: 1 1 0; padding-inline: 8px; }
    .tabs { display: flex; }
    .tab { flex: 1; }
    .cards { grid-template-columns: repeat(2, 1fr); gap: 9px; }
    .card { min-height: 82px; padding: 13px; }
    .card .v { font-size: 22px; }
    .funnel { display: flex; }
    section.panel { padding: 15px; }
    .search-panel { padding: 15px !important; }
    .search-heading { margin-bottom: 15px; }
    .searchform { align-items: stretch; }
    .searchform fieldset { max-width: 100%; overflow-x: auto; padding-bottom: 2px; }
    .segwrap { flex: 0 0 auto; }
    .resultshead { align-items: flex-start; flex-direction: column; margin-top: 18px; }
    .resultfilters { display: grid; grid-template-columns: 1fr 1fr; width: 100%; }
    .jobsearchbox { grid-column: 1 / -1; width: 100%; max-width: none; }
    .resultfilters select { width: 100%; }
    .jobgrid { grid-template-columns: 1fr; }
    .jobcard { min-height: 0; }
    .filters { justify-content: stretch; flex-basis: 100%; }
    .searchbox { max-width: none; }
    .tablewrap { margin: 0 -15px -15px; overflow: visible; }
    table, thead, tbody, tr, td { display: block; }
    thead { display: none; }
    tbody { padding: 0 15px 15px; }
    tbody tr { display: grid; grid-template-columns: 1fr auto; gap: 10px 14px;
               margin-top: 10px; padding: 14px; border: 1px solid var(--line);
               border-radius: 11px; background: var(--panel); }
    tbody tr:hover { background: var(--panel-2); }
    th, td, th:first-child, td:first-child, th:last-child, td:last-child {
      padding: 0; border: 0; max-width: none;
    }
    td.company { grid-column: 1; grid-row: 1; }
    td.title { grid-column: 1 / -1; grid-row: 2; min-width: 0; }
    td[data-label="Status"] { grid-column: 2; grid-row: 1; }
    td[data-label="Applied"] { grid-column: 1; grid-row: 3; font-size: 12px; color: var(--muted); }
    td[data-label="Age"] { grid-column: 2; grid-row: 3; font-size: 12px; }
    select.status { min-width: 96px; }
    tr.is-ghosted td:first-child, tr.needs-attention td:first-child { border-left: 0; }
  }
  @media (max-width: 430px) {
    .filters { display: grid; grid-template-columns: 1fr; }
    .searchbox { width: 100%; }
    #statusfilter { width: 100%; }
    .search-heading { align-items: stretch; flex-direction: column; }
    .search-heading #searchbtn { width: 100%; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; }
    .search-progress-bar { width: 100%; animation: none; opacity: .7; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="brand">
      <div class="brandmark" aria-hidden="true">J</div>
      <div class="brandcopy">
        <h1>Job Hunt</h1>
        <span class="sub" id="dbinfo"></span>
      </div>
    </div>
    <div class="contact-links" role="group" aria-label="Copy contact links">
      <button class="copylink" id="copy-linkedin" type="button"
              data-label="LinkedIn" data-url="https://www.linkedin.com/in/anton-perch-768578113/"
              aria-label="Copy LinkedIn URL">
        <span>LINKEDIN</span>
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2"></rect>
          <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"></path>
        </svg>
      </button>
      <button class="copylink" id="copy-github" type="button"
              data-label="GitHub" data-url="https://github.com/Perchusha"
              aria-label="Copy GitHub URL">
        <span>GITHUB</span>
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2"></rect>
          <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"></path>
        </svg>
      </button>
      <button class="copylink" id="copy-portfolio" type="button"
              data-label="Portfolio" data-url="https://perchusha.github.io/portfolio/"
              aria-label="Copy Portfolio URL">
        <span>PORTFOLIO</span>
        <svg viewBox="0 0 24 24" fill="none" stroke-width="2" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2"></rect>
          <path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"></path>
        </svg>
      </button>
    </div>
  </header>

  <nav class="tabs">
    <button class="tab is-active" data-view="tracker" type="button">Tracker</button>
    <button class="tab" data-view="search" type="button">Search</button>
  </nav>

  <!-- ---------------- Tracker ---------------- -->
  <div class="view" id="view-tracker">
    <div class="cards" id="cards"></div>

    <div class="tracker-layout">
      <section class="panel funnel-panel">
        <h2>Pipeline</h2>
        <p class="section-kicker">Where your applications stand</p>
        <div class="funnel" id="funnel"></div>
      </section>

      <section class="panel applications-panel">
        <div class="panelhead">
          <div class="paneltitle">
            <h2>Applications</h2>
            <p class="section-kicker" id="applicationcount">0 applications</p>
          </div>
          <div class="filters">
            <label class="searchbox">
              <span class="filterlabel">Search applications</span>
              <input type="search" id="appsearch" placeholder="Search company, role, location…" autocomplete="off">
            </label>
            <label class="filterlabel" for="statusfilter">Filter by status</label>
            <select id="statusfilter" aria-label="Filter by status"><option value="">All statuses</option></select>
          </div>
        </div>
        <div class="tablewrap">
          <table>
            <thead>
              <tr>
                <th class="sortable" data-sort="company" tabindex="0">Company <span class="arrow"></span></th>
                <th>Role</th>
                <th class="sortable" data-sort="status" tabindex="0">Status <span class="arrow"></span></th>
                <th class="sortable" data-sort="applied" tabindex="0">Applied <span class="arrow"></span></th>
                <th class="sortable" data-sort="days" tabindex="0">Age <span class="arrow"></span></th>
              </tr>
            </thead>
            <tbody id="rows"></tbody>
          </table>
          <div class="empty" id="empty" hidden>No applications match these filters.</div>
        </div>
      </section>
    </div>
  </div>

  <!-- ---------------- Search ---------------- -->
  <div class="view" id="view-search" hidden>
    <section class="panel search-panel">
      <div class="search-heading">
        <h2>Find jobs</h2>
        <button type="submit" form="searchform" id="searchbtn">↻ Обновить</button>
      </div>
      <form class="pico searchform" id="searchform">
        <!-- Real radios painted as a segmented control: one mutually exclusive
             choice, so arrow keys and the screen-reader group come from the
             markup instead of being reimplemented in JS. -->
        <fieldset id="datefilter">
          <legend class="sr">Опубликовано</legend>
          <div class="segwrap">
            <label><input type="radio" name="age" value="1"><span>24 часа</span></label>
            <label><input type="radio" name="age" value="3"><span>3 дня</span></label>
            <label><input type="radio" name="age" value="7"><span>неделя</span></label>
            <label><input type="radio" name="age" value="14"><span>2 недели</span></label>
            <label><input type="radio" name="age" value="30" checked><span>месяц</span></label>
          </div>
        </fieldset>

        <!-- Checkboxes, not radios: several boards at once. Rendered from the
             profile's source list, so the filter can only narrow it. -->
        <fieldset>
          <legend class="sr">Источники</legend>
          <div class="srcpills" id="sourcefilter"></div>
        </fieldset>

        <fieldset class="toggles">
          <legend class="sr">Показывать</legend>
          <label><input type="checkbox" role="switch" id="hideApplied" checked> скрыть отклики</label>
          <label><input type="checkbox" role="switch" id="showDismissed"> скрытые <span id="dismissedCount"></span></label>
          <label title="вакансии, которые отсеяли твои правила скрининга (src/screening.ts) — с причиной на карточке"><input type="checkbox" role="switch" id="showRuleHidden"> скрыто правилами <span id="ruleHiddenCount"></span></label>
        </fieldset>
      </form>
      <div class="search-progress" id="searchprogress" role="status" hidden
           aria-label="Поиск вакансий выполняется">
        <div class="search-progress-track" aria-hidden="true"><span class="search-progress-bar"></span></div>
        <div class="search-progress-copy">
          <span>Опрашиваю источники…</span>
          <span id="searchtimer" aria-hidden="true">0 сек</span>
        </div>
      </div>
    </section>

    <div class="resultshead">
      <div class="resulttitle">
        <h2>Matches</h2>
        <span id="resultcount">Waiting for search</span>
      </div>
      <div class="resultfilters">
        <label class="searchbox jobsearchbox">
          <span class="filterlabel">Search loaded jobs</span>
          <input type="search" id="jobsearch" placeholder="Search title, company, technology…" autocomplete="off">
        </label>
        <label class="filterlabel" for="matchfilter">Match quality</label>
        <select id="matchfilter" aria-label="Match quality">
          <option value="">All matches</option>
          <option value="high">High match only</option>
        </select>
        <label class="filterlabel" for="jobsort">Sort results</label>
        <select id="jobsort" aria-label="Sort results">
          <option value="match">Best match</option>
          <option value="newest">Newest first</option>
          <option value="company">Company A–Z</option>
        </select>
      </div>
    </div>
    <div class="jobgrid" id="jobgrid"></div>
    <div class="loadmore" id="loadmore" hidden></div>
    <div class="empty search-empty" id="searchempty" hidden>
      <div class="emptyicon" aria-hidden="true">⌕</div>
      <strong>No matching jobs</strong>
      <span id="searchemptynote">Try a broader text search or change the match filter.</span>
      <button type="button" class="btn ghost" id="clearjobfilters">Clear result filters</button>
    </div>
  </div>
</div>
<div class="toast" id="toast" role="status" aria-live="polite"></div>

<script>
const STATUSES = __STATUSES__;
// The boards this dashboard may query, straight from SEARCH_DEFAULTS.sources.
// Injected rather than hardcoded so the filter cannot drift from the profile.
const SOURCES = __SOURCES__;
// Funnel order: how an application actually progresses.
const FUNNEL_ORDER = ["applied","responded","screening","interview","offer","rejected","dropped","ghosted"];

let applications = [];
let sort = { key: "applied", dir: "desc" };
let statusFilter = "";
let applicationQuery = "";
// Job keys (src/jobkey.ts) already in the funnel, so search cards render as
// "already added". Keys, not raw URLs: a tracking parameter appended by a board
// must not turn a job you applied to back into a fresh card.
let trackedUrls = new Set();
let searchResults = [];
// Search only runs on demand, so remember whether the tab has loaded once.
let searchLoaded = false;
let hideApplied = true;
let showDismissed = false;
// Rule hits come with the search (job.screen) and are filtered here, so the
// toggle is instant and the reason is on the card when it is on.
let showRuleHidden = false;
let jobQuery = "";
let jobSort = "match";
let matchFilter = "";
// Which boards to query. All of them until you say otherwise; unticking one is
// how you drop LinkedIn and get a fast search back.
let activeSources = new Set(SOURCES);
let searchTimer = null;
// Only the newest search may paint: a slow cold search must not land after a
// quick cache hit for a newer chip and overwrite it.
let searchSeq = 0;
let searchAbort = null;
/*
 * How many cards are drawn. The search returns a couple of hundred matches and
 * the page filters more of them out again, so rendering the lot up front is
 * both slow and pointless — this grows as you reach the bottom.
 *
 * Reset only when a new search runs. Re-rendering for any other reason (a
 * filter toggle, a job added to the funnel) keeps whatever you had scrolled
 * into view, instead of yanking the list back to one screenful.
 */
const RENDER_BATCH = 24;
let renderLimit = RENDER_BATCH;
// What the last render decided was visible, before the render cap.
let visibleCount = 0;
// Always a real window now — the widest option is a month, which is also
// SEARCH_DEFAULTS.hoursOld. Sent to /api/search as hoursOld; see the radio
// handler for why it is a search parameter and not a filter over the results.
let maxAgeDays = 30;
// Kept so toggling a filter re-renders instead of re-running the search.
let lastSearchPayload = { jobs: [] };

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(message, isError) {
  const el = $("toast");
  el.textContent = message;
  el.className = "toast show" + (isError ? " err" : "");
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = "toast"; }, 2600);
}

async function writeClipboard(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through for browsers that expose Clipboard API but deny it.
    }
  }

  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("Copy command failed");
}

async function copyContactLink(button) {
  const label = button.dataset.label;
  try {
    await writeClipboard(button.dataset.url);
    button.classList.add("is-copied");
    clearTimeout(button._copyTimer);
    button._copyTimer = setTimeout(() => button.classList.remove("is-copied"), 1600);
    toast("Ссылка " + label + " скопирована");
  } catch {
    toast("Не удалось скопировать ссылку " + label, true);
  }
}

function pct(value) { return Math.round((value || 0) * 100) + "%"; }
function ageInDays(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return isNaN(t) ? null : Math.max(0, Math.floor((Date.now() - t) / 86400000));
}
function ageLabel(iso) {
  const days = ageInDays(iso);
  if (days === null) return "без даты";
  if (days === 0) return "сегодня";
  if (days === 1) return "вчера";
  return days + " дн. назад";
}
function shortDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? "—" : d.toISOString().slice(0, 10);
}

function renderStats(stats) {
  // The database path is diagnostics, not a headline — it lives in the tooltip.
  $("dbinfo").innerHTML = "<code>" + esc(stats.total) + "</code> applications &middot; ghosted after <code>"
    + esc(stats.staleDays) + "d</code> of silence";
  $("dbinfo").title = stats.dbPath || "";

  // A rate belongs next to the count it is a rate of, not in a card of its own.
  const cards = [
    { k: "Applied", v: stats.total, note: "" },
    { k: "Responded", v: stats.responded, note: pct(stats.responseRate) },
    { k: "Interviews", v: (stats.funnel.screening || 0) + (stats.funnel.interview || 0), note: "" },
    { k: "Offers", v: stats.funnel.offer || 0, note: "" },
    { k: "Ghosted", v: stats.funnel.ghosted || 0, note: pct(stats.ghostRate) },
    { k: "Avg reply", v: stats.avgDaysToResponse === null ? "—" : stats.avgDaysToResponse + "d", note: "" },
  ];
  $("cards").innerHTML = cards.map((c) =>
    '<div class="card"><div class="k">' + esc(c.k) + '</div><div class="v">' + esc(c.v)
    + (c.note ? ' <small>' + esc(c.note) + '</small>' : '') + '</div></div>').join("");

  const max = Math.max(1, ...FUNNEL_ORDER.map((s) => stats.funnel[s] || 0));
  $("funnel").innerHTML = FUNNEL_ORDER.map((s) => {
    const n = stats.funnel[s] || 0;
    return '<div class="frow" data-s="' + s + '"><div class="fname">' + esc(s) + '</div>'
      + '<div class="bar"><i style="width:' + (n / max * 100).toFixed(1) + '%"></i></div>'
      + '<div class="fcount">' + n + '</div></div>';
  }).join("");
}

function sortedApplications() {
  const dir = sort.dir === "asc" ? 1 : -1;
  const rank = (s) => { const i = FUNNEL_ORDER.indexOf(s); return i === -1 ? 99 : i; };
  // "open" = still alive: sent, and not yet closed out or ghosted.
  const matches = (a) => {
    const statusMatches = !statusFilter
      || (statusFilter === "open"
        ? ["applied", "responded", "screening", "interview"].includes(a.status)
        : a.status === statusFilter);
    if (!statusMatches) return false;
    if (!applicationQuery) return true;
    const haystack = [a.company, a.title, a.location, a.source, a.salary]
      .filter(Boolean).join(" ").toLocaleLowerCase();
    return haystack.includes(applicationQuery);
  };
  const base = applications.filter(matches);
  return base.slice().sort((a, b) => {
    switch (sort.key) {
      case "company": return dir * a.company.localeCompare(b.company);
      case "status":  return dir * (rank(a.status) - rank(b.status));
      case "days":    return dir * (a.daysSinceApplied - b.daysSinceApplied);
      default:        return dir * (Date.parse(a.applied_at || 0) - Date.parse(b.applied_at || 0));
    }
  });
}

function renderRows() {
  const rows = sortedApplications();
  $("empty").hidden = rows.length > 0;
  $("empty").textContent = applications.length
    ? "No applications match these filters."
    : "Nothing here yet — search for jobs and add them to the pipeline.";
  $("applicationcount").textContent = rows.length === applications.length
    ? rows.length + (rows.length === 1 ? " application" : " applications")
    : rows.length + " of " + applications.length + " applications";

  $("rows").innerHTML = rows.map((a) => {
    const options = STATUSES.map((s) =>
      '<option value="' + s + '"' + (s === a.status ? " selected" : "") + '>' + s + "</option>").join("");
    const titleCell = a.url
      ? '<a href="' + esc(a.url) + '" target="_blank" rel="noreferrer noopener">' + esc(a.title) + "</a>"
      : esc(a.title);
    const sub = [a.source, a.location, a.salary].filter(Boolean).map(esc).join(" &middot; ");

    const needsAttention = !a.ghosted && a.status === "applied" && a.daysSinceApplied >= 7;
    const rowClass = a.ghosted ? "is-ghosted" : (needsAttention ? "needs-attention" : "");
    const ageClass = needsAttention ? "age-pill warm" : "age-pill";
    const age = a.daysSinceApplied === 0 ? "Today"
      : a.daysSinceApplied === 1 ? "1 day" : a.daysSinceApplied + " days";

    return '<tr class="' + rowClass + '">'
      + '<td class="company" data-label="Company">' + esc(a.company) + "</td>"
      + '<td class="title" data-label="Role">' + titleCell + (sub ? '<div class="meta">' + sub + "</div>" : "") + "</td>"
      + '<td data-label="Status"><select class="status" aria-label="Status for ' + esc(a.company)
      + '" data-s="' + esc(a.status) + '" data-id="' + a.id + '">'
      + options + "</select></td>"
      + '<td class="nowrap" data-label="Applied">' + shortDate(a.applied_at)
      + (a.response_at ? '<div class="meta">reply ' + shortDate(a.response_at) + "</div>" : "") + "</td>"
      + '<td class="nowrap" data-label="Age"><span class="' + ageClass + '">' + age + "</span>"
      + (a.daysToResponse !== null ? '<div class="meta">' + a.daysToResponse + "d to reply</div>" : "") + "</td>"
      + "</tr>";
  }).join("");

  document.querySelectorAll("#rows select").forEach((select) => {
    select.addEventListener("change", async (event) => {
      const id = event.target.dataset.id;
      const status = event.target.value;
      try {
        const response = await fetch("/api/applications/" + id + "/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error || response.statusText);
        toast("#" + id + " -> " + status);
        await load();
      } catch (error) {
        toast("Update failed: " + error.message, true);
        await load();
      }
    });
  });
}

function bindSorting() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    const activate = () => {
      const key = th.dataset.sort;
      sort = { key, dir: sort.key === key && sort.dir === "desc" ? "asc" : "desc" };
      document.querySelectorAll("th.sortable .arrow").forEach((a) => (a.textContent = ""));
      th.querySelector(".arrow").textContent = sort.dir === "desc" ? "\\u25bc" : "\\u25b2";
      renderRows();
    };
    th.addEventListener("click", activate);
    th.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activate();
      }
    });
  });
}

/* ---------------- search view ---------------- */

/** Draw one more batch. Cheap: the jobs are already here, only the DOM grows. */
function showMore() {
  if (renderLimit >= visibleCount) return;
  renderLimit += RENDER_BATCH;
  renderSearch(lastSearchPayload);
}

function professionalLevel(job) {
  return job.match && job.match.level
    ? job.match.level
    : (job.fit >= 6 ? "high" : job.fit > 0 ? "medium" : "low");
}

/** The source pills are rebuilt when their selection changes. */
function renderSourceFilter() {
  $("sourcefilter").innerHTML = SOURCES.map((source) => {
    const on = activeSources.has(source);
    return "<label>"
      + '<input type="checkbox" value="' + esc(source) + '"' + (on ? " checked" : "") + ">"
      + "<span>" + esc(source) + "</span></label>";
  }).join("");

  document.querySelectorAll("#sourcefilter input[type=checkbox]").forEach((box) => {
    box.addEventListener("change", () => {
      if (box.checked) activeSources.add(box.value);
      else activeSources.delete(box.value);
      // Zero boards is not a search. Refuse rather than fetch nothing.
      if (activeSources.size === 0) {
        activeSources.add(box.value);
        renderSourceFilter();
        toast("Хотя бы один источник должен остаться", true);
        return;
      }
      return searchLoaded ? runSearch() : renderSourceFilter();
    });
  });
}

/** What the posting text says (src/workmode.ts): office days, Polish. */
function signalBadges(job) {
  const signals = job.signals || {};
  let html = "";
  if (signals.mode) {
    html += '<span class="sig warn" title="' + esc(signals.context || "") + '">'
      + (signals.mode === "onsite" ? "офис" : "офис N дн.") + "</span>";
  }
  if (signals.polishRequired) html += '<span class="sig warn" title="the posting asks for fluent Polish">польский C1+</span>';
  else if (signals.inPolish) html += '<span class="sig" title="the posting is written in Polish">PL</span>';
  if (job.workMode === "hybrid" || job.workMode === "office") {
    html += '<span class="sig warn" title="the board lists it as ' + esc(job.workMode) + '">' + esc(job.workMode) + "</span>";
  }
  return html;
}

/** A card my screening rules would hide (src/screening.ts); shown under its toggle. */
function isRuleHidden(job) {
  return Boolean(job.screen && job.screen.bucket === "dismiss");
}

/*
 * One-click reasons for "скрыть". A reason teaches the screening rules: role
 * reasons hide reposts of that role, and "не интересна компания" — the same
 * string as COMPANY_REASON in src/screening.ts — hides the whole company. A
 * plain "скрыть" still works and still counts towards the company rule.
 */
const HIDE_REASONS = ["не remote", "не тот стек", "уровень (mid/junior)", "не интересна компания",
  "зарплата ниже", "уже откликался в другом месте"];

function renderSearch(payload) {
  const all = payload.jobs || [];
  searchResults = all;

  // Local filters are instant: they narrow the loaded set without asking the
  // external boards again.
  let visible = all.filter((job) => {
    if (job.dismissed && !showDismissed) return false;
    if (isRuleHidden(job) && !showRuleHidden) return false;
    if (hideApplied && trackedUrls.has(job.key)) return false;
    if (matchFilter && professionalLevel(job) !== matchFilter) return false;
    if (jobQuery) {
      const haystack = [job.title, job.company, job.location, job.source, job.salary,
        job.match && job.match.reason, job.eligibility && job.eligibility.reason]
        .filter(Boolean).join(" ").toLocaleLowerCase();
      if (!haystack.includes(jobQuery)) return false;
    }
    // hoursOld only reaches the scraped boards; the free feeds ignore it, so
    // the window is enforced again here — otherwise Himalayas alone would put
    // month-old rows in a "24 hours" list. A posting that will not say how old
    // it is cannot be shown to be inside the window, so it goes.
    const age = ageInDays(job.postedAt);
    if (age === null || age > maxAgeDays) return false;
    return true;
  });

  if (jobSort === "newest") {
    visible = visible.slice().sort((a, b) =>
      (Date.parse(b.postedAt || 0) || 0) - (Date.parse(a.postedAt || 0) || 0));
  } else if (jobSort === "company") {
    visible = visible.slice().sort((a, b) =>
      String(a.company || "").localeCompare(String(b.company || "")));
  }

  $("searchempty").hidden = visible.length > 0;
  const hasResultFilters = Boolean(jobQuery || matchFilter);
  $("searchemptynote").textContent = hasResultFilters
    ? "Try a broader text search or change the match filter."
    : "No eligible jobs were returned. Try a wider date range or another source.";
  $("clearjobfilters").hidden = !hasResultFilters;
  $("resultcount").textContent = visible.length === all.length
    ? visible.length + (visible.length === 1 ? " match" : " matches")
    : visible.length + " of " + all.length + " matches";
  visibleCount = visible.length;
  // Never draw fewer cards than are already on screen — a re-render triggered
  // by adding a job must not collapse a list you have scrolled through.
  const shown = visible.slice(0, renderLimit);

  const dismissedTotal = payload.dismissedCount || 0;
  $("dismissedCount").textContent = dismissedTotal ? "(" + dismissedTotal + ")" : "";
  const ruleHiddenTotal = all.filter((job) => !job.dismissed && isRuleHidden(job)).length;
  $("ruleHiddenCount").textContent = ruleHiddenTotal ? "(" + ruleHiddenTotal + ")" : "";

  const remaining = visible.length - shown.length;
  $("loadmore").hidden = remaining <= 0;
  $("loadmore").innerHTML = remaining <= 0 ? ""
    : "<span>показано " + shown.length + " из " + visible.length + "</span>"
      + '<button type="button" id="loadmorebtn">Показать ещё ' + Math.min(RENDER_BATCH, remaining) + "</button>";
  if (remaining > 0) {
    const more = document.getElementById("loadmorebtn");
    if (more) more.addEventListener("click", showMore);
  }

  $("jobgrid").innerHTML = shown.map((job) => {
    const index = all.indexOf(job);
    const tracked = trackedUrls.has(job.key);
    // HIGH/MEDIUM is professional match. Eligibility is separate: incomplete
    // LinkedIn metadata must not make a strong Senior React role look mediocre.
    const level = professionalLevel(job);
    const eligibilityLevel = job.eligibility.level;
    const classes = ["jobcard", "lvl-" + level];
    if (job.dismissed) classes.push("is-dismissed");
    if (isRuleHidden(job)) classes.push("is-rulehidden");
    if (tracked) classes.push("is-applied");

    const fitBadge = typeof job.fit === "number"
      ? '<span class="fit ' + (job.fit >= 6 ? "good" : job.fit < 0 ? "bad" : "")
        + '" title="stack fit from your CV: higher is a better match">fit '
        + (job.fit > 0 ? "+" : "") + job.fit + "</span>"
      : "";
    const eligibilityBadge = '<span class="geo '
      + (eligibilityLevel === "high" ? "confirmed" : "check")
      + '" title="work eligibility from Poland">'
      + (eligibilityLevel === "high" ? "geo confirmed" : "geo check") + "</span>";

    // A hidden card offers restore instead of add — you cannot funnel what you
    // have already told the tool to stop showing.
    const action = job.dismissed
      ? '<button class="linkbtn restore" data-restore="' + index + '">вернуть</button>'
      : '<button class="btn' + (tracked ? " ghost" : "") + '" data-add="' + index + '"'
        + (tracked ? " disabled" : "")
        + ' title="записать как отклик — в воронке всё считается applied">'
        + (tracked ? "✓ Откликнулся" : "В воронку") + "</button>"
        + '<button class="btn secondary" data-hide="' + index + '" title="never show this job again">скрыть</button>'
        + '<details class="hidewhy"><summary title="скрыть с причиной — причины учатся правилами">▾</summary><div>'
        + HIDE_REASONS.map((reason) => '<button type="button" class="linkbtn" data-hide-reason="' + index
          + '" data-reason="' + esc(reason) + '">' + esc(reason) + "</button>").join("")
        + "</div></details>";

    return '<article class="' + classes.join(" ") + '">'
      + '<a class="cardlink" href="' + esc(job.applyUrl) + '" target="_blank" rel="noreferrer noopener"'
      + ' aria-label="Открыть вакансию: ' + esc(job.title) + '"></a>'
      + '<div class="row"><span class="lvl ' + esc(level) + '">' + esc(level) + "</span>"
      + '<span class="src">' + esc(job.source) + "</span>" + fitBadge + eligibilityBadge + signalBadges(job)
      + '<span class="when">' + esc(ageLabel(job.postedAt)) + "</span></div>"
      + '<h3>' + esc(job.title) + "</h3>"
      + '<div class="co">' + esc(job.company) + "</div>"
      + '<div class="details">'
      + (job.location ? '<span title="Location">⌖ ' + esc(job.location) + "</span>" : "")
      + (job.salary
        ? '<span class="sal' + (job.belowSalaryFloor ? " low" : "") + '" title="'
          + (job.belowSalaryFloor ? "Published pay is below your floor" : "Salary") + '">· '
          + esc(job.salary) + "</span>"
        : "")
      + "</div>"
      + '<div class="reason">' + esc(job.match && job.match.reason ? job.match.reason + ". " : "")
      + esc(job.eligibility.reason) + "</div>"
      + (isRuleHidden(job) ? '<div class="rulehit">правило: ' + esc(job.screen.reason) + "</div>" : "")
      + ((job.screen && job.screen.flags) || []).map((flag) => '<div class="flag">⚑ ' + esc(flag) + "</div>").join("")
      + '<div class="actions">' + action + "</div></article>";
  }).join("");

  document.querySelectorAll("#jobgrid button[data-add]").forEach((button) => {
    button.addEventListener("click", () => addToFunnel(Number(button.dataset.add), button));
  });
  document.querySelectorAll("#jobgrid button[data-hide-reason]").forEach((button) => {
    button.addEventListener("click", () => dismiss(Number(button.dataset.hideReason), button.dataset.reason));
  });
  document.querySelectorAll("#jobgrid button[data-hide]").forEach((button) => {
    button.addEventListener("click", () => dismiss(Number(button.dataset.hide)));
  });
  document.querySelectorAll("#jobgrid button[data-restore]").forEach((button) => {
    button.addEventListener("click", () => restore(Number(button.dataset.restore)));
  });
}

async function dismiss(index, reason) {
  const job = searchResults[index];
  if (!job) return;
  try {
    const response = await fetch("/api/dismissed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: job.applyUrl, title: job.title, company: job.company, reason: reason || null }),
    });
    if (!response.ok) throw new Error((await response.json()).error || response.statusText);
    job.dismissed = true;
    toast(job.company + " скрыта");
    renderSearch(lastSearchPayload);
  } catch (error) {
    toast("Could not hide: " + error.message, true);
  }
}

async function restore(index) {
  const job = searchResults[index];
  if (!job) return;
  try {
    const response = await fetch("/api/dismissed", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: job.applyUrl }),
    });
    if (!response.ok) throw new Error((await response.json()).error || response.statusText);
    job.dismissed = false;
    toast(job.company + " возвращена");
    renderSearch(lastSearchPayload);
  } catch (error) {
    toast("Could not restore: " + error.message, true);
  }
}

async function addToFunnel(index, button) {
  const job = searchResults[index];
  if (!job) return;
  button.disabled = true;
  try {
    const response = await fetch("/api/applications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: job.applyUrl,
        title: job.title,
        company: job.company,
        source: job.source,
        location: job.location,
        salary: job.salary,
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || response.statusText);

    trackedUrls.add(job.key);
    toast(payload.result === "already_tracked"
      ? job.company + " already in the funnel"
      : job.company + " logged as applied");
    // Re-render instead of just relabelling the button: with "скрыть те, что в
    // воронке" ticked the card has to leave the grid, which is the whole point
    // of that filter.
    renderSearch(lastSearchPayload);
    await load(); // refresh funnel + table behind the tab
  } catch (error) {
    button.disabled = false;
    toast("Could not add: " + error.message, true);
  }
}

function startSearchProgress() {
  const startedAt = Date.now();
  const progress = $("searchprogress");
  progress.hidden = false;
  $("searchtimer").textContent = "0 сек";
  clearInterval(searchTimer);
  searchTimer = setInterval(() => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    $("searchtimer").textContent = seconds + " сек";
  }, 1000);
}

function stopSearchProgress() {
  clearInterval(searchTimer);
  searchTimer = null;
  $("searchprogress").hidden = true;
}

async function runSearch(event) {
  const forceRefresh = Boolean(event);
  if (event) event.preventDefault();
  const seq = ++searchSeq;
  // The server keeps scraping and caches the result; aborting only stops this
  // page from waiting for an answer it no longer wants.
  if (searchAbort) searchAbort.abort();
  const abort = typeof AbortController === "function" ? new AbortController() : null;
  searchAbort = abort;
  const button = $("searchbtn");
  $("view-search").classList.add("is-loading");
  button.disabled = true;
  button.textContent = "Ищу…";
  startSearchProgress();
  try {
    // What to look for is fully profile-driven (see src/profile.ts); the only
    // parameters are the two things the page itself can change.
    const params = [];
    if (showDismissed) params.push("includeDismissed=1");
    // Always explicit: the server intersects this with the profile's own list,
    // so the URL can narrow the search but never widen it.
    params.push("sources=" + [...activeSources].join(","));
    params.push("hoursOld=" + maxAgeDays * 24);
    // Automatic loads and filter changes may use the server cache. Submitting
    // the Refresh form is the explicit escape hatch for fresh board data.
    if (forceRefresh) params.push("refresh=1");
    const response = await fetch("/api/search" + (params.length ? "?" + params.join("&") : ""),
      abort ? { signal: abort.signal } : undefined);
    const payload = await response.json();
    if (seq !== searchSeq) return;
    if (!response.ok) throw new Error(payload.error || response.statusText);
    lastSearchPayload = payload;
    // A new result set starts at one screenful again.
    renderLimit = RENDER_BATCH;
    renderSearch(payload);
    searchLoaded = true;
  } catch (error) {
    if (seq !== searchSeq) return;
    toast("Search failed: " + error.message, true);
  } finally {
    // A superseded search leaves the progress bar to the one still running.
    if (seq !== searchSeq) return;
    stopSearchProgress();
    $("view-search").classList.remove("is-loading");
    button.disabled = false;
    button.textContent = "↻ Обновить";
  }
}

/* ---------------- tabs, filters, boot ---------------- */

function showView(name) {
  // First visit to Search runs the profile search; after that it is manual.
  if (name === "search" && !searchLoaded) runSearch();
  $("view-tracker").hidden = name !== "tracker";
  $("view-search").hidden = name !== "search";
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("is-active", tab.dataset.view === name);
  });
}

function bindChrome() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showView(tab.dataset.view));
  });
  for (const id of ["copy-linkedin", "copy-github", "copy-portfolio"]) {
    const button = $(id);
    button.addEventListener("click", () => copyContactLink(button));
  }
  $("searchform").addEventListener("submit", runSearch);

  /*
   * Posting age goes to the server rather than filtering the 200 cards already
   * here: recency is only the fourth sort key, so the top of the list is mostly
   * older postings and a local cut would show "0 fresh jobs". The server cuts
   * the window from its cached month before the limit — no boards are asked.
   */
  document.querySelectorAll("#datefilter input[type=radio]").forEach((radio) => {
    radio.addEventListener("change", () => {
      const days = Number(radio.value);
      if (days === maxAgeDays) return;
      maxAgeDays = days;
      // Returned so callers (and the test harness) can await the re-search.
      return searchLoaded ? runSearch() : renderSearch(lastSearchPayload);
    });
  });

  // Hiding applied-to jobs is a local filter — no need to hit the network.
  $("hideApplied").addEventListener("change", (event) => {
    hideApplied = event.target.checked;
    renderSearch(lastSearchPayload);
  });
  // Showing hidden jobs changes what the server returns, so re-run the search.
  // Rule hits are already in the payload: a local filter, no request.
  $("showRuleHidden").addEventListener("change", (event) => {
    showRuleHidden = event.target.checked;
    renderSearch(lastSearchPayload);
  });
  $("showDismissed").addEventListener("change", (event) => {
    showDismissed = event.target.checked;
    if (searchLoaded) runSearch();
  });

  $("jobsearch").addEventListener("input", (event) => {
    jobQuery = event.target.value.trim().toLocaleLowerCase();
    renderLimit = RENDER_BATCH;
    renderSearch(lastSearchPayload);
  });
  $("matchfilter").addEventListener("change", (event) => {
    matchFilter = event.target.value;
    renderLimit = RENDER_BATCH;
    renderSearch(lastSearchPayload);
  });
  $("jobsort").addEventListener("change", (event) => {
    jobSort = event.target.value;
    renderSearch(lastSearchPayload);
  });
  $("clearjobfilters").addEventListener("click", () => {
    jobQuery = "";
    matchFilter = "";
    $("jobsearch").value = "";
    $("matchfilter").value = "";
    renderLimit = RENDER_BATCH;
    renderSearch(lastSearchPayload);
    $("jobsearch").focus();
  });

  const filter = $("statusfilter");
  // Grouped shortcut first: "open" is everything still alive, which is the
  // question you ask most often and no single status answers.
  for (const [value, label] of [["open", "open (в работе)"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    filter.appendChild(option);
  }
  for (const status of STATUSES) {
    const option = document.createElement("option");
    option.value = status;
    option.textContent = status;
    filter.appendChild(option);
  }
  filter.addEventListener("change", () => {
    statusFilter = filter.value;
    renderRows();
  });

  $("appsearch").addEventListener("input", (event) => {
    applicationQuery = event.target.value.trim().toLocaleLowerCase();
    renderRows();
  });
}

async function load() {
  try {
    const [stats, list] = await Promise.all([
      fetch("/api/stats").then((r) => r.json()),
      fetch("/api/applications").then((r) => r.json()),
    ]);
    applications = list.applications || [];
    trackedUrls = new Set(applications.map((a) => a.url_key).filter(Boolean));
    renderStats(stats);
    renderRows();
  } catch (error) {
    toast("Load failed: " + error.message, true);
  }
}

/*
 * Extend the list as the sentinel comes into view. The sentinel lives outside
 * #jobgrid and is never replaced, so this is attached once and survives every
 * re-render. rootMargin starts the next batch before you hit the bottom.
 *
 * Guarded: the test harness has no IntersectionObserver, and the button inside
 * the sentinel does the same job by hand.
 */
function watchForBottom() {
  if (typeof IntersectionObserver !== "function") return;
  new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) showMore();
  }, { rootMargin: "400px" }).observe($("loadmore"));
}

bindChrome();
bindSorting();
watchForBottom();
// Draw the pills before the first search so the filter is usable while it runs.
renderSourceFilter();
load();
// The MCP server may write while this page is open; WAL makes the reads safe.
setInterval(load, 15000);
</script>
</body>
</html>`;

/* ------------------------------------------------------------------ */
/* Server                                                             */
/* ------------------------------------------------------------------ */

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

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? HOST}`);
  const path = url.pathname;

  try {
    if (request.method === "GET" && (path === "/" || path === "/index.html")) {
      // STATUSES is injected so the dropdown can never drift from the DB vocabulary.
      const html = PAGE.replace("__STATUSES__", JSON.stringify(STATUSES)).replace(
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

    if (request.method === "GET" && path === "/pico.css") {
      response.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Content-Length": Buffer.byteLength(PICO_CSS),
        // Pinned in package.json, so it only changes when the dependency does.
        "Cache-Control": "public, max-age=86400",
      });
      response.end(PICO_CSS);
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
      const cached = await cachedProfileSearch(
        profileCacheKey(sources),
        {
          // The cache holds the whole month, hidden jobs included; the date
          // window and the hidden list are applied below, per request, so
          // neither a date chip nor a dismissal re-scrapes the boards.
          excludeUrls: [],
          limit: FEED_LIMIT,
          sources,
        },
        forceRefresh,
      );
      const result = cached.result;

      // Narrower windows are cut from the cached month before the page limit,
      // so fresh jobs are ranked against each other, as a dedicated search
      // would. Postings with no date stay; the page decides about those.
      const windowStart = Date.now() - (hoursOld ?? SEARCH_DEFAULTS.hoursOld) * 3_600_000;
      const inWindow = result.jobs.filter(
        (job) => !job.postedAt || Date.parse(job.postedAt) >= windowStart,
      );

      // Read on every request, so dismissals written by the MCP or funnel.mjs
      // while the page is open apply at once.
      const dismissedKeys = new Set(listDismissedKeys());
      const keyed = inWindow.map((job) => ({ job, key: jobKey(job.url) }));
      const kept = includeDismissed ? keyed : keyed.filter(({ key }) => !dismissedKeys.has(key));

      // My screening rules (src/screening.ts), against the funnel and the hidden
      // list as they are right now. Rule hits stay in the payload with their
      // reason; the page keeps them behind the "скрыто правилами" toggle.
      const context = buildContext(listApplications(), listDismissed());
      const screened = screenAll(
        kept.map(({ job, key }) => ({ ...job, key, dismissed: dismissedKeys.has(key) })),
        context,
      );
      const page = screened.slice(0, SEARCH_DEFAULTS.limit);
      const hiddenByRules: Record<string, number> = {};
      for (const row of page) {
        if (row.bucket === "dismiss") hiddenByRules[row.reason] = (hiddenByRules[row.reason] ?? 0) + 1;
      }

      const levelCounts: Record<string, number> = {};
      for (const { job } of page) {
        levelCounts[job.eligibility.level] = (levelCounts[job.eligibility.level] ?? 0) + 1;
      }

      sendJson(response, 200, {
        // `key` is the job's identity (src/jobkey.ts): the page compares it with
        // the funnel's url_key. `dismissed` renders a restore button.
        jobs: page.map(({ job, bucket, reason, flags }) => ({
          ...presentJob(job),
          key: job.key,
          dismissed: job.dismissed,
          screen: { bucket, reason, flags },
        })),
        dismissedCount: dismissedKeys.size,
        sourceCounts: result.sourceCounts,
        reports: result.reports,
        counts: {
          ...result.counts,
          hiddenForDismissed: keyed.length - kept.length,
          hiddenByRules,
          returned: page.length,
        },
        levelCounts,
        cache: {
          hit: cached.hit,
          stale: cached.stale,
          ageSeconds: Math.floor(cached.ageMs / 1000),
          ttlSeconds: Math.floor(SEARCH_CACHE_TTL_MS / 1000),
        },
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
      });

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
   * Warm the default search, so the first click on Search joins a pass that is
   * already running instead of starting one. Identical requests share the
   * cached promise, so there is never a second pass. JOBHUNT_WARM=0 turns it
   * off (the UI tests do, to keep their board traffic to what they assert on).
   */
  if (process.env["JOBHUNT_WARM"] !== "0") {
    const sources = [...SEARCH_DEFAULTS.sources];
    cachedProfileSearch(
      profileCacheKey(sources),
      { excludeUrls: [], limit: FEED_LIMIT, sources },
      false,
    ).catch((error: unknown) => {
      console.error(`Warm-up search failed: ${error instanceof Error ? error.message : error}`);
    });
  }
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use. Set JOBHUNT_PORT to something else, e.g. JOBHUNT_PORT=4322 npm run dashboard`,
    );
    process.exit(1);
  }
  throw error;
});
