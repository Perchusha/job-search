/**
 * dashboard.ts — local read/write view of the same SQLite file the MCP uses.
 *
 * node:http only, no framework, no CDN. Binds to localhost: this is a
 * single-user tool with no auth by design.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

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

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job Hunt</title>
<style>
  :root {
    color-scheme: light dark;
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
    margin: 0; padding: 28px 20px 60px;
    background: var(--bg); color: var(--text);
    font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
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
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11.5px; font-weight: 600;
           background: var(--panel-2); border: 1px solid var(--line); text-transform: capitalize; }
  .badge.offer { color: var(--good); border-color: var(--good); }
  .badge.interview, .badge.screening { color: var(--accent); border-color: var(--accent); }
  .badge.ghosted { color: var(--bad); border-color: var(--bad); }
  .badge.rejected { color: var(--bad); }
  .badge.responded { color: var(--warn); border-color: var(--warn); }
  .nowrap { white-space: nowrap; font-variant-numeric: tabular-nums; }
  select { background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
           border-radius: 6px; padding: 4px 6px; font: inherit; font-size: 12.5px; cursor: pointer; }
  .notes { max-width: 320px; white-space: pre-wrap; word-break: break-word;
           color: var(--muted); font-size: 12px; max-height: 4.6em; overflow: auto; }
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

  /* search form */
  .searchform { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .searchform input[type="text"], .searchform input[type="number"] {
    background: var(--panel-2); color: var(--text); border: 1px solid var(--line);
    border-radius: 6px; padding: 7px 10px; font: inherit; font-size: 13px; }
  .searchform input[type="text"] { flex: 1 1 260px; min-width: 180px; }
  .searchform input[type="number"] { width: 130px; }
  .searchform label { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); }
  .btn { background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 8px 16px;
         font: inherit; font-weight: 600; font-size: 13px; cursor: pointer; }
  .btn:hover { filter: brightness(1.08); }
  .btn[disabled] { opacity: .55; cursor: default; filter: none; }
  .btn.ghost { background: var(--panel-2); color: var(--text); border: 1px solid var(--line); }
  .srcline { margin-top: 12px; color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }
  .srcline .skip { color: var(--warn); }
  .profileline { color: var(--muted); font-size: 12.5px; }
  .profileline b { color: var(--text); font-weight: 600; }
  .srcline b { color: var(--text); font-weight: 600; }

  /* job cards */
  .jobgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
  .jobcard { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
             padding: 14px; display: flex; flex-direction: column; gap: 8px; }
  .jobcard.lvl-high { border-left: 3px solid var(--good); }
  .jobcard.lvl-medium { border-left: 3px solid var(--warn); }
  .jobcard h3 { margin: 0; font-size: 14.5px; line-height: 1.35; }
  .jobcard h3 a { color: inherit; text-decoration: none; }
  .jobcard h3 a:hover { color: var(--accent); }
  .jobcard .co { font-size: 13px; font-weight: 600; color: var(--muted); }
  .jobcard .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .jobcard .reason { font-size: 12px; color: var(--muted); line-height: 1.45; }
  .jobcard .sal { font-size: 12.5px; font-variant-numeric: tabular-nums; }
  .jobcard .actions { display: flex; gap: 8px; align-items: center; margin-top: auto; padding-top: 4px; }
  .lvl { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px;
         font-weight: 700; text-transform: uppercase; letter-spacing: .04em; }
  .lvl.high { color: var(--good); border: 1px solid var(--good); }
  .lvl.medium { color: var(--warn); border: 1px solid var(--warn); }
  .src { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
  .fit { font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums;
         padding: 1px 6px; border-radius: 4px; background: var(--panel-2); color: var(--muted); }
  .fit.good { color: var(--good); }
  .fit.bad { color: var(--bad); }
  .applylink { font-size: 12.5px; color: var(--accent); text-decoration: none; }
  .linkbtn { background: none; border: 0; color: var(--muted); font: inherit; font-size: 12.5px;
             cursor: pointer; padding: 0; text-decoration: underline; text-underline-offset: 2px; }
  .linkbtn:hover { color: var(--bad); }
  .linkbtn.restore:hover { color: var(--good); }
  .jobcard.is-dismissed { opacity: .5; }
  .jobcard.is-applied { border-left-color: var(--accent); }
  .searchfilters { display: flex; gap: 14px; align-items: center; flex-wrap: wrap;
                   margin-top: 10px; font-size: 12.5px; color: var(--muted); }
  .searchfilters label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
  .applylink:hover { text-decoration: underline; }

  /* saved (pre-application) is visually quieter than a real application */
  .badge.saved { color: var(--muted); border-style: dashed; }
  tr.is-saved { opacity: .82; }
  tr.is-saved td:first-child { border-left: 3px solid var(--line); }
  .frow[data-s="saved"] .bar > i { background: var(--muted); }

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
            <th>Notes</th>
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
      <form class="searchform" id="searchform">
        <button class="btn" type="submit" id="searchbtn">↻ Обновить</button>
        <span class="profileline" id="profileline"></span>
      </form>
      <div class="searchfilters">
        <label><input type="checkbox" id="hideApplied"> скрыть те, что в воронке</label>
        <label><input type="checkbox" id="showDismissed"> показать скрытые <span id="dismissedCount"></span></label>
      </div>
      <div class="srcline" id="srcline">Jobs you can apply to from Poland. <code>low</code>-eligibility postings are filtered out.</div>
    </section>

    <div class="jobgrid" id="jobgrid"></div>
    <div class="empty" id="searchempty" hidden>No eligible jobs for that search. Try a broader query.</div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const STATUSES = __STATUSES__;
// Funnel order: how an application actually progresses.
const FUNNEL_ORDER = ["saved","applied","responded","screening","interview","offer","rejected","ghosted"];

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
function shortDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? "—" : d.toISOString().slice(0, 10);
}

function renderStats(stats) {
  $("dbinfo").innerHTML = "tracking <code>" + esc(stats.total) + "</code> roles &middot; ghost threshold <code>"
    + esc(stats.staleDays) + "d</code> &middot; <code>" + esc(stats.dbPath || "") + "</code>";

  const cards = [
    { k: "Applied", v: stats.totalApplied, note: stats.total !== stats.totalApplied ? "of " + stats.total + " tracked" : "" },
    { k: "Responded", v: stats.responded, note: "" },
    { k: "Response rate", v: pct(stats.responseRate), note: "" },
    { k: "Ghost rate", v: pct(stats.ghostRate), note: stats.funnel.ghosted + " ghosted" },
    { k: "Interviews", v: (stats.funnel.screening || 0) + (stats.funnel.interview || 0), note: "" },
    { k: "Offers", v: stats.funnel.offer || 0, note: "" },
    { k: "Avg days to reply", v: stats.avgDaysToResponse === null ? "—" : stats.avgDaysToResponse, note: "" },
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
  // "applied+" = everything except a bookmark; "open" = still alive.
  const matches = (a) => {
    if (!statusFilter) return true;
    if (statusFilter === "applied+") return a.status !== "saved";
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

    const rowClass = a.ghosted ? "is-ghosted" : (a.status === "saved" ? "is-saved" : "");

    return '<tr class="' + rowClass + '">'
      + '<td class="company">' + esc(a.company) + "</td>"
      + '<td class="title">' + titleCell + (sub ? '<div class="meta">' + sub + "</div>" : "") + "</td>"
      + '<td><span class="badge ' + esc(a.status) + '">' + esc(a.status) + "</span><br>"
      + '<select data-id="' + a.id + '">' + options + "</select></td>"
      + '<td class="nowrap">' + shortDate(a.applied_at)
      // For a saved row this date is when it entered the funnel, not an application date.
      + (a.status === "saved" ? '<div class="meta">saved, not applied</div>' : "")
      + (a.response_at ? '<div class="meta">reply ' + shortDate(a.response_at) + "</div>" : "") + "</td>"
      + '<td class="nowrap">' + a.daysSinceApplied
      + (a.daysToResponse !== null ? '<div class="meta">' + a.daysToResponse + "d to reply</div>" : "") + "</td>"
      + '<td><div class="notes">' + esc(a.notes || "") + "</div></td>"
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

function renderSearch(payload) {
  const all = payload.jobs || [];
  searchResults = all;

  // Local filters: applied-to jobs and (unless asked for) hidden ones.
  const visible = all.filter((job) => {
    if (job.dismissed && !showDismissed) return false;
    if (hideApplied && trackedUrls.has(job.applyUrl)) return false;
    return true;
  });

  $("searchempty").hidden = visible.length > 0;

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

  // Per-source counts, so an empty or skipped feed is visible, not mysterious.
  const parts = (payload.reports || []).map((r) =>
    r.skipped
      ? '<span class="skip">' + esc(r.source) + " skipped (" + esc(r.skipped) + ")</span>"
      : esc(r.source) + " " + r.count);
  const c = payload.counts || {};
  let line = parts.join(" &middot; ") + " &rarr; <b>" + (c.afterEligibility || 0) + " eligible</b>";
  if (c.deduped !== undefined && c.fetched !== undefined) {
    line += ' <span class="meta">(' + c.fetched + " fetched, " + (c.fetched - c.deduped) + " duplicates removed)</span>";
  }
  if (c.hiddenForFit) line += ' <span class="meta">, ' + c.hiddenForFit + " dropped: wrong stack / junior</span>";
  if (c.hiddenForDismissed) line += ' <span class="meta">, ' + c.hiddenForDismissed + " hidden by you</span>";
  if (c.hiddenForUnknownSalary) line += ' <span class="skip">' + c.hiddenForUnknownSalary + " hidden: no published salary</span>";
  if (visible.length !== all.length) {
    line += ' <span class="meta">&middot; showing ' + visible.length + " of " + all.length + "</span>";
  }
  $("srcline").innerHTML = line;

  $("jobgrid").innerHTML = visible.map((job) => {
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
        + (tracked ? " disabled" : "") + ">"
        + (tracked ? "✓ В воронке" : "В воронку") + "</button>"
        + '<button class="linkbtn" data-hide="' + index + '" title="never show this job again">скрыть</button>';

    return '<article class="' + classes.join(" ") + '">'
      + '<div class="row"><span class="lvl ' + esc(level) + '">' + esc(level) + "</span>"
      + '<span class="src">' + esc(job.source) + "</span>" + fitBadge + "</div>"
      + '<h3><a href="' + esc(job.applyUrl) + '" target="_blank" rel="noreferrer noopener">' + esc(job.title) + "</a></h3>"
      + '<div class="co">' + esc(job.company) + "</div>"
      + (job.salary ? '<div class="sal">' + esc(job.salary) + "</div>" : "")
      + '<div class="reason">' + esc(job.eligibility.reason) + "</div>"
      + '<div class="actions">' + action
      + '<a class="applylink" href="' + esc(job.applyUrl) + '" target="_blank" rel="noreferrer noopener">open posting &rarr;</a>'
      + "</div></article>";
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
    button.textContent = "\\u2713 \\u0412 \\u0432\\u043e\\u0440\\u043e\\u043d\\u043a\\u0435";
    button.classList.add("ghost");
    toast(payload.result === "already_tracked"
      ? job.company + " was already in the funnel"
      : job.company + " added as saved");
    await load(); // refresh funnel + table behind the tab
  } catch (error) {
    button.disabled = false;
    toast("Could not add: " + error.message, true);
  }
}

async function runSearch(event) {
  if (event) event.preventDefault();
  const button = $("searchbtn");
  button.disabled = true;
  button.textContent = "Ищу…";
  $("srcline").textContent = "Опрашиваю вакансии…";
  try {
    // No query params: the search is fully profile-driven (see src/profile.ts).
    const response = await fetch("/api/search" + (showDismissed ? "?includeDismissed=1" : ""));
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || response.statusText);
    lastSearchPayload = payload;
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
  // Grouped shortcuts first: "applied+" is everything you actually sent, which
  // is the question you ask most often and no single status answers.
  for (const [value, label] of [["applied+", "applied+ (откликнулся)"], ["open", "open (в работе)"]]) {
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

bindChrome();
bindSorting();
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
      const html = PAGE.replace("__STATUSES__", JSON.stringify(STATUSES));
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      response.end(html);
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
      const result = await searchForProfile(includeDismissed ? { excludeUrls: [] } : {});
      const dismissedUrls = new Set(listDismissed().map((row) => row.url));

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
        // Echo the profile so the page can show what it searched for.
        profile: {
          queries: TARGET_QUERIES,
          location: SEARCH_DEFAULTS.location,
          remoteOnly: SEARCH_DEFAULTS.remoteOnly,
          hoursOld: SEARCH_DEFAULTS.hoursOld,
          sources: SEARCH_DEFAULTS.sources,
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
      // Default 'saved': finding a job is not applying to one.
      const status =
        statusRaw && (STATUSES as readonly string[]).includes(statusRaw)
          ? (statusRaw as Status)
          : ("saved" as Status);

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

    // Hide a job from every future search (dashboard, find_jobs and harvest).
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
