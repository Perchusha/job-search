/**
 * dashboard.ts — local read/write view of the same SQLite file the MCP uses.
 *
 * node:http, no build step. Binds to localhost: this is a single-user tool with
 * no auth by design.
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

import {
  DEFAULT_STALE_DAYS,
  STATUSES,
  dismissJob,
  getStats,
  insertApplication,
  listApplications,
  listDismissed,
  resolveDbPath,
  undismissJob,
  updateStatus,
  type Status,
} from "./db.ts";
import { presentJob, searchForProfile } from "./pipeline.ts";
import { SEARCH_DEFAULTS, TARGET_QUERIES } from "./profile.ts";

const PORT = Number(process.env["JOBHUNT_PORT"] ?? 4321);
const HOST = "127.0.0.1";
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

type SearchCacheEntry = {
  createdAt: number;
  result: ReturnType<typeof searchForProfile>;
};

/**
 * Server-owned rather than browser-owned: page reloads share it, concurrent
 * identical searches share the same promise, and API responses can remain
 * `no-store` so a browser never serves stale application/dismissal state.
 */
const searchCache = new Map<string, SearchCacheEntry>();

async function cachedProfileSearch(
  key: string,
  overrides: Parameters<typeof searchForProfile>[0],
  forceRefresh: boolean,
): Promise<{ result: Awaited<ReturnType<typeof searchForProfile>>; hit: boolean; ageMs: number }> {
  const now = Date.now();
  const existing = searchCache.get(key);
  if (!forceRefresh && existing && now - existing.createdAt < SEARCH_CACHE_TTL_MS) {
    return { result: await existing.result, hit: true, ageMs: now - existing.createdAt };
  }

  // Keep uncommon filter combinations from accumulating forever.
  for (const [cachedKey, entry] of searchCache) {
    if (now - entry.createdAt >= SEARCH_CACHE_TTL_MS) searchCache.delete(cachedKey);
  }

  const result = searchForProfile(overrides);
  const entry = { createdAt: now, result };
  searchCache.set(key, entry);
  try {
    return { result: await result, hit: false, ageMs: 0 };
  } catch (error) {
    // A transient board failure must not poison every request for the next hour.
    if (searchCache.get(key) === entry) searchCache.delete(key);
    throw error;
  }
}

/**
 * Read once at boot rather than per request. A missing file means a broken
 * install, and failing here says so plainly instead of serving an unstyled page.
 */
const PICO_CSS = readFileSync(
  createRequire(import.meta.url).resolve("@picocss/pico/css/pico.conditional.min.css"),
  "utf8",
);

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job Hunt</title>
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
    --bg: #0f1115;
    --panel: #171a21;
    --panel-2: #1e222b;
    --line: #2a2f3a;
    --text: #e6e8ee;
    --muted: #9aa1b1;
    --accent: #6ea8fe;
    --warn: #f0a35e;
    --bad: #e5766f;
    --good: #6ddf9c;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f6f7f9; --panel: #fff; --panel-2: #f0f2f5; --line: #dfe3ea;
      --text: #1a1d24; --muted: #666e7e; --accent: #1d63d1;
      --warn: #a4601a; --bad: #b3352c; --good: #1d7a48;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 28px 20px 60px; min-height: 100vh; min-height: 100dvh;
    background: var(--bg); color: var(--text);
    font: 14px/1.5 var(--font-sans);
  }
  .wrap { max-width: 1180px; margin: 0 auto; }
  header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin-bottom: 22px; }
  h1 { font-size: 20px; margin: 0; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 12.5px; }
  .sub code { background: var(--panel-2); padding: 1px 5px; border-radius: 4px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 10px; margin-bottom: 12px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; }
  .card .k { color: var(--muted); font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; }
  .card .v { font-size: 22px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .card .v small { font-size: 12px; font-weight: 400; color: var(--muted); }
  section.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 12px; }
  /* funnel */
  .funnel { display: flex; flex-direction: column; gap: 7px; }
  .frow { display: grid; grid-template-columns: 92px 1fr 40px; align-items: center; gap: 10px; }
  .frow .fname { font-size: 12.5px; color: var(--muted); text-transform: capitalize; }
  .bar { height: 20px; background: var(--panel-2); border-radius: 5px; overflow: hidden; }
  .bar > i { display: block; height: 100%; background: var(--accent); border-radius: 5px; transition: width .25s; }
  .frow[data-s="offer"] .bar > i { background: var(--good); }
  .frow[data-s="rejected"] .bar > i, .frow[data-s="ghosted"] .bar > i { background: var(--bad); }
  /* Walking away is not bad news from them — grey, not red. */
  .frow[data-s="dropped"] .bar > i { background: var(--muted); }
  .frow .fcount { text-align: right; font-variant-numeric: tabular-nums; font-size: 13px; }
  /* table */
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 600; white-space: nowrap; }
  th.sortable { cursor: pointer; user-select: none; }
  th.sortable:hover { color: var(--text); }
  th .arrow { opacity: .5; font-size: 10px; }
  tbody tr:hover { background: var(--panel-2); }
  tr.is-ghosted { background: color-mix(in srgb, var(--bad) 9%, transparent); }
  tr.is-ghosted td:first-child { border-left: 3px solid var(--bad); }
  .company { font-weight: 600; }
  .title a { color: inherit; text-decoration: none; border-bottom: 1px dotted var(--muted); }
  .title a:hover { color: var(--accent); }
  .meta { color: var(--muted); font-size: 12px; }
  .nowrap { white-space: nowrap; font-variant-numeric: tabular-nums; }
  select { background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
           border-radius: 6px; padding: 4px 6px; font: inherit; font-size: 12.5px; cursor: pointer; }
  /*
   * The dropdown IS the status display. There used to be a badge above it
   * saying the same word twice; colour carries that meaning now, and there is
   * one control instead of a label plus a control that can disagree.
   */
  select.status { font-weight: 600; text-transform: capitalize; padding: 5px 8px; }
  select.status:hover { border-color: var(--muted); }
  select.status[data-s="offer"] { color: var(--good); border-color: var(--good); }
  select.status[data-s="interview"], select.status[data-s="screening"] { color: var(--accent); border-color: var(--accent); }
  select.status[data-s="responded"] { color: var(--warn); border-color: var(--warn); }
  select.status[data-s="rejected"], select.status[data-s="ghosted"] { color: var(--bad); border-color: var(--bad); }
  select.status[data-s="dropped"] { color: var(--muted); border-style: dashed; }
  .empty { color: var(--muted); padding: 26px 0; text-align: center; }
  .toast { position: fixed; right: 16px; bottom: 16px; background: var(--panel); border: 1px solid var(--line);
           border-radius: 8px; padding: 9px 14px; font-size: 13px; opacity: 0; transform: translateY(6px);
           transition: .18s; pointer-events: none; }
  .toast.show { opacity: 1; transform: none; }
  .toast.err { border-color: var(--bad); color: var(--bad); }

  /* tabs */
  .tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid var(--line); }
  .tab { background: none; border: 0; border-bottom: 2px solid transparent; color: var(--muted);
         font: inherit; font-weight: 600; font-size: 13px; padding: 8px 14px; cursor: pointer; }
  .tab:hover { color: var(--text); }
  .tab.is-active { color: var(--accent); border-bottom-color: var(--accent); }

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
  .srcpills .n { opacity: .7; font-variant-numeric: tabular-nums; font-weight: 400; }
  /* A board that failed is not a board that returned nothing — say which. */
  .srcpills label.is-skipped span { border-color: var(--warn); color: var(--warn); }
  .srcpills input:checked + span .n.warn { color: #fff; }

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
  .srcline { margin-top: 12px; color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }
  .srcline .skip { color: var(--warn); }
  .profileline { color: var(--muted); font-size: 12.5px; margin-bottom: 14px; }
  .profileline b { color: var(--text); font-weight: 600; }
  .srcline b { color: var(--text); font-weight: 600; }

  /* job cards */
  .jobgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
  .jobcard { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
             padding: 14px; display: flex; flex-direction: column; gap: 8px;
             position: relative; transition: border-color .15s, box-shadow .15s; }
  .jobcard:hover { border-color: var(--muted); box-shadow: 0 2px 14px rgba(0,0,0,.14); }
  .jobcard:hover h3 { color: var(--accent); }
  .jobcard .cardlink { position: absolute; inset: 0; z-index: 1; border-radius: inherit; }
  .jobcard .cardlink:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .jobcard.lvl-high { border-left: 3px solid var(--good); }
  .jobcard.lvl-medium { border-left: 3px solid var(--warn); }
  .jobcard h3 { margin: 0; font-size: 14.5px; line-height: 1.35; }
  .jobcard .co { font-size: 13px; font-weight: 600; color: var(--muted); }
  .jobcard .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .jobcard .reason { font-size: 12px; color: var(--muted); line-height: 1.45; }
  .jobcard .sal { font-size: 12.5px; font-variant-numeric: tabular-nums; }
  .jobcard .actions { display: flex; gap: 8px; align-items: center; margin-top: auto; padding-top: 4px;
                      position: relative; z-index: 2; }
  .lvl { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px;
         font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .lvl.high { color: var(--good); border: 1px solid var(--good); }
  .lvl.medium { color: var(--warn); border: 1px solid var(--warn); }
  .src { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
  .fit { font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums;
         padding: 1px 6px; border-radius: 4px; background: var(--panel-2); color: var(--muted); }
  .fit.good { color: var(--good); }
  .fit.bad { color: var(--bad); }
  .linkbtn { background: none; border: 0; color: var(--muted); font: inherit; font-size: 12.5px;
             cursor: pointer; padding: 0; text-decoration: underline; text-underline-offset: 2px; }
  .linkbtn:hover { color: var(--bad); }
  .linkbtn.restore:hover { color: var(--good); }
  .jobcard.is-dismissed { opacity: .5; }
  .jobcard.is-applied { border-left-color: var(--accent); }
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
               gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .panelhead h2 { margin: 0; }
  .filters { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--muted); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Job Hunt</h1>
    <span class="sub" id="dbinfo"></span>
  </header>

  <nav class="tabs">
    <button class="tab is-active" data-view="tracker" type="button">Tracker</button>
    <button class="tab" data-view="search" type="button">Search</button>
  </nav>

  <!-- ---------------- Tracker ---------------- -->
  <div class="view" id="view-tracker">
    <div class="cards" id="cards"></div>

    <section class="panel">
      <h2>Funnel</h2>
      <div class="funnel" id="funnel"></div>
    </section>

    <section class="panel">
      <div class="panelhead">
        <h2>Applications</h2>
        <div class="filters">
          <label for="statusfilter">Status</label>
          <select id="statusfilter"><option value="">all</option></select>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th class="sortable" data-sort="company">Company <span class="arrow"></span></th>
            <th>Title</th>
            <th class="sortable" data-sort="status">Status <span class="arrow"></span></th>
            <th class="sortable" data-sort="applied">Applied <span class="arrow"></span></th>
            <th class="sortable" data-sort="days">Days <span class="arrow"></span></th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
      <div class="empty" id="empty" hidden>Nothing here yet — search for jobs and add them to the funnel.</div>
    </section>
  </div>

  <!-- ---------------- Search ---------------- -->
  <div class="view" id="view-search" hidden>
    <section class="panel">
      <div class="profileline" id="profileline"></div>
      <form class="pico searchform" id="searchform">
        <button type="submit" id="searchbtn">↻ Обновить</button>

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
          <label><input type="checkbox" role="switch" id="hideApplied"> скрыть отклики</label>
          <label><input type="checkbox" role="switch" id="showDismissed"> скрытые <span id="dismissedCount"></span></label>
        </fieldset>
      </form>
      <div class="srcline" id="srcline">Jobs you can apply to from Poland. <code>low</code>-eligibility postings are filtered out.</div>
    </section>

    <div class="jobgrid" id="jobgrid"></div>
    <div class="loadmore" id="loadmore" hidden></div>
    <div class="empty" id="searchempty" hidden>No eligible jobs for that search. Try a broader query.</div>
  </div>
</div>
<div class="toast" id="toast"></div>

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
// URLs already in the funnel, so search cards can render as "already added".
let trackedUrls = new Set();
let searchResults = [];
// Search only runs on demand, so remember whether the tab has loaded once.
let searchLoaded = false;
let hideApplied = false;
let showDismissed = false;
// Which boards to query. All of them until you say otherwise; unticking one is
// how you drop LinkedIn and get a fast search back.
let activeSources = new Set(SOURCES);
// Per-source fetch counts from the last search, shown on the pills.
let sourceReports = [];
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
    if (!statusFilter) return true;
    if (statusFilter === "open") return ["applied", "responded", "screening", "interview"].includes(a.status);
    return a.status === statusFilter;
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

  $("rows").innerHTML = rows.map((a) => {
    const options = STATUSES.map((s) =>
      '<option value="' + s + '"' + (s === a.status ? " selected" : "") + '>' + s + "</option>").join("");
    const titleCell = a.url
      ? '<a href="' + esc(a.url) + '" target="_blank" rel="noreferrer noopener">' + esc(a.title) + "</a>"
      : esc(a.title);
    const sub = [a.source, a.location, a.salary].filter(Boolean).map(esc).join(" &middot; ");

    const rowClass = a.ghosted ? "is-ghosted" : "";

    return '<tr class="' + rowClass + '">'
      + '<td class="company">' + esc(a.company) + "</td>"
      + '<td class="title">' + titleCell + (sub ? '<div class="meta">' + sub + "</div>" : "") + "</td>"
      + '<td><select class="status" data-s="' + esc(a.status) + '" data-id="' + a.id + '">'
      + options + "</select></td>"
      + '<td class="nowrap">' + shortDate(a.applied_at)
      + (a.response_at ? '<div class="meta">reply ' + shortDate(a.response_at) + "</div>" : "") + "</td>"
      + '<td class="nowrap">' + a.daysSinceApplied
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
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      sort = { key, dir: sort.key === key && sort.dir === "desc" ? "asc" : "desc" };
      document.querySelectorAll("th.sortable .arrow").forEach((a) => (a.textContent = ""));
      th.querySelector(".arrow").textContent = sort.dir === "desc" ? "\\u25bc" : "\\u25b2";
      renderRows();
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

/**
 * The source pills. Rebuilt rather than patched: there are three of them, and a
 * rebuild cannot leave a count attached to the wrong board.
 */
function renderSourceFilter() {
  const byName = {};
  for (const report of sourceReports) byName[report.source] = report;

  $("sourcefilter").innerHTML = SOURCES.map((source) => {
    const report = byName[source];
    const on = activeSources.has(source);
    // No count until this board has actually been asked — 0 would be a lie.
    const tail = !report ? ""
      : report.skipped ? ' <span class="n warn">!</span>'
      : ' <span class="n">' + report.count + "</span>";
    const title = report && report.skipped
      ? source + " skipped: " + report.skipped
      : source === "linkedin"
        ? "LinkedIn даёт ~900 постингов, которых нет на Indeed, но растягивает поиск с ~3 с до ~80 с. Снимите галочку, чтобы искать быстро."
        : "";
    return '<label class="' + (report && report.skipped ? "is-skipped" : "") + '"'
      + (title ? ' title="' + esc(title) + '"' : "") + ">"
      + '<input type="checkbox" value="' + esc(source) + '"' + (on ? " checked" : "") + ">"
      + "<span>" + esc(source) + tail + "</span></label>";
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

function renderSearch(payload) {
  const all = payload.jobs || [];
  searchResults = all;

  // Local filters: age, applied-to jobs, and (unless asked for) hidden ones.
  let hiddenForAge = 0;
  let hiddenForNoDate = 0;
  const visible = all.filter((job) => {
    if (job.dismissed && !showDismissed) return false;
    if (hideApplied && trackedUrls.has(job.applyUrl)) return false;
    // hoursOld only reaches the scraped boards; the free feeds ignore it, so
    // the window is enforced again here — otherwise Himalayas alone would put
    // month-old rows in a "24 hours" list. A posting that will not say how old
    // it is cannot be shown to be inside the window, so it goes, and is counted.
    const age = ageInDays(job.postedAt);
    if (age === null) { hiddenForNoDate++; return false; }
    if (age > maxAgeDays) { hiddenForAge++; return false; }
    return true;
  });

  $("searchempty").hidden = visible.length > 0;
  visibleCount = visible.length;
  // Never draw fewer cards than are already on screen — a re-render triggered
  // by adding a job must not collapse a list you have scrolled through.
  const shown = visible.slice(0, renderLimit);

  const dismissedTotal = payload.dismissedCount || 0;
  $("dismissedCount").textContent = dismissedTotal ? "(" + dismissedTotal + ")" : "";

  // Make the profile visible: a one-button feed should not be a black box.
  const prof = payload.profile;
  if (prof) {
    $("profileline").innerHTML = "searching <b>" + (prof.queries || []).map(esc).join("</b> · <b>")
      + "</b> in <b>" + esc(prof.location) + "</b>"
      + (prof.remoteOnly ? ", remote only" : "")
      + " · last " + Math.round((prof.hoursOld || 0) / 24) + "d"
      + ' · <span class="meta">edit src/profile.ts to change</span>';
  }

  // Per-source counts live on the pills now; this line is the pipeline story.
  sourceReports = payload.reports || [];
  renderSourceFilter();

  const c = payload.counts || {};
  let line = (c.fetched || 0) + " fetched &rarr; <b>" + (c.afterEligibility || 0) + " eligible</b>";
  if (c.deduped !== undefined && c.fetched !== undefined) {
    line += ' <span class="meta">(' + (c.fetched - c.deduped) + " duplicates removed)</span>";
  }
  if (c.hiddenForFit) line += ' <span class="meta">, ' + c.hiddenForFit + " dropped: wrong stack / junior</span>";
  if (c.hiddenForDismissed) line += ' <span class="meta">, ' + c.hiddenForDismissed + " hidden by you</span>";
  if (c.hiddenForUnknownSalary) line += ' <span class="skip">' + c.hiddenForUnknownSalary + " hidden: no published salary</span>";
  if (hiddenForAge) line += ' <span class="meta">, ' + hiddenForAge + " старше фильтра</span>";
  if (hiddenForNoDate) line += ' <span class="meta">, ' + hiddenForNoDate + " без даты публикации</span>";
  if (visible.length !== all.length) {
    line += ' <span class="meta">&middot; showing ' + visible.length + " of " + all.length + "</span>";
  }
  if (payload.cache) {
    const minutes = Math.floor((payload.cache.ageSeconds || 0) / 60);
    line += payload.cache.hit
      ? ' <span class="meta">&middot; кеш ' + (minutes > 0 ? minutes + " мин назад" : "только что") + "</span>"
      : ' <span class="meta">&middot; обновлено сейчас</span>';
  }
  $("srcline").innerHTML = line;

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
    const tracked = trackedUrls.has(job.applyUrl);
    const level = job.eligibility.level;
    const classes = ["jobcard", "lvl-" + level];
    if (job.dismissed) classes.push("is-dismissed");
    if (tracked) classes.push("is-applied");

    const fitBadge = typeof job.fit === "number"
      ? '<span class="fit ' + (job.fit >= 6 ? "good" : job.fit < 0 ? "bad" : "")
        + '" title="stack fit from your CV: higher is a better match">fit '
        + (job.fit > 0 ? "+" : "") + job.fit + "</span>"
      : "";

    // A hidden card offers restore instead of add — you cannot funnel what you
    // have already told the tool to stop showing.
    const action = job.dismissed
      ? '<button class="linkbtn restore" data-restore="' + index + '">вернуть</button>'
      : '<button class="btn' + (tracked ? " ghost" : "") + '" data-add="' + index + '"'
        + (tracked ? " disabled" : "")
        + ' title="записать как отклик — в воронке всё считается applied">'
        + (tracked ? "✓ Откликнулся" : "В воронку") + "</button>"
        + '<button class="btn secondary" data-hide="' + index + '" title="never show this job again">скрыть</button>';

    return '<article class="' + classes.join(" ") + '">'
      + '<a class="cardlink" href="' + esc(job.applyUrl) + '" target="_blank" rel="noreferrer noopener"'
      + ' aria-label="Открыть вакансию: ' + esc(job.title) + '"></a>'
      + '<div class="row"><span class="lvl ' + esc(level) + '">' + esc(level) + "</span>"
      + '<span class="src">' + esc(job.source) + "</span>" + fitBadge
      + '<span class="when">' + esc(ageLabel(job.postedAt)) + "</span></div>"
      + '<h3>' + esc(job.title) + "</h3>"
      + '<div class="co">' + esc(job.company) + "</div>"
      + (job.salary ? '<div class="sal">' + esc(job.salary) + "</div>" : "")
      + '<div class="reason">' + esc(job.eligibility.reason) + "</div>"
      + '<div class="actions">' + action + "</div></article>";
  }).join("");

  document.querySelectorAll("#jobgrid button[data-add]").forEach((button) => {
    button.addEventListener("click", () => addToFunnel(Number(button.dataset.add), button));
  });
  document.querySelectorAll("#jobgrid button[data-hide]").forEach((button) => {
    button.addEventListener("click", () => dismiss(Number(button.dataset.hide)));
  });
  document.querySelectorAll("#jobgrid button[data-restore]").forEach((button) => {
    button.addEventListener("click", () => restore(Number(button.dataset.restore)));
  });
}

async function dismiss(index) {
  const job = searchResults[index];
  if (!job) return;
  try {
    const response = await fetch("/api/dismissed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: job.applyUrl, title: job.title, company: job.company }),
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

    trackedUrls.add(job.applyUrl);
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

async function runSearch(event) {
  const forceRefresh = Boolean(event);
  if (event) event.preventDefault();
  const button = $("searchbtn");
  button.disabled = true;
  button.textContent = "Ищу…";
  $("srcline").textContent = "Опрашиваю вакансии…";
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
    const response = await fetch("/api/search" + (params.length ? "?" + params.join("&") : ""));
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || response.statusText);
    lastSearchPayload = payload;
    // A new result set starts at one screenful again.
    renderLimit = RENDER_BATCH;
    renderSearch(payload);
    searchLoaded = true;
  } catch (error) {
    $("srcline").textContent = "Search failed: " + error.message;
    toast("Search failed: " + error.message, true);
  } finally {
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
  $("searchform").addEventListener("submit", runSearch);

  /*
   * Posting age is a SEARCH parameter, not a filter over what came back. The
   * ranked list is capped at SEARCH_DEFAULTS.limit, and recency is only the
   * fourth sort key — so filtering afterwards shows "0 fresh jobs" whenever the
   * top of the list happens to be older postings, which is most of the time.
   * Narrowing the window server-side ranks fresh jobs against each other.
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
  $("showDismissed").addEventListener("change", (event) => {
    showDismissed = event.target.checked;
    if (searchLoaded) runSearch();
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
}

async function load() {
  try {
    const [stats, list] = await Promise.all([
      fetch("/api/stats").then((r) => r.json()),
      fetch("/api/applications").then((r) => r.json()),
    ]);
    applications = list.applications || [];
    trackedUrls = new Set(applications.map((a) => a.url).filter(Boolean));
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
      const dismissedRows = listDismissed();
      const dismissedUrls = new Set(dismissedRows.map((row) => row.url));
      const cacheKey = JSON.stringify({
        sources: [...sources].sort(),
        hoursOld: hoursOld ?? SEARCH_DEFAULTS.hoursOld,
        includeDismissed,
        // Normal searches depend on this DB state. Including it in the key also
        // notices dismissals written by the MCP while the dashboard is open.
        dismissed: includeDismissed ? [] : [...dismissedUrls].sort(),
      });
      const cached = await cachedProfileSearch(cacheKey, {
        ...(includeDismissed ? { excludeUrls: [] } : {}),
        ...(hoursOld === undefined ? {} : { hoursOld }),
        sources,
      }, forceRefresh);
      const result = cached.result;

      sendJson(response, 200, {
        // `dismissed` lets the page render a restore button on hidden cards.
        jobs: result.jobs.map((job) => ({
          ...presentJob(job),
          dismissed: dismissedUrls.has(job.url),
        })),
        dismissedCount: dismissedUrls.size,
        sourceCounts: result.sourceCounts,
        reports: result.reports,
        counts: result.counts,
        levelCounts: result.levelCounts,
        cache: {
          hit: cached.hit,
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
  console.log(`Reading database     →  ${resolveDbPath()}`);
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
