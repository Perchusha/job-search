/**
 * tests/ui.mjs — runs the dashboard's real page script against a real server.
 *
 * Run: npm run test:ui
 *
 * It spawns its own dashboard on a spare port with a throwaway database, seeds
 * rows through the real API, then evaluates the script of src/dashboard.html
 * (as the server serves it) against a minimal DOM shim. The live-search part
 * hits real job boards, so this needs network. Claude's verdicts come from a
 * stand-in (tests/fake-claude.mjs): offline, and nothing spent.
 *
 * The page acts through a few functions — act(), pickStack(), pickJob(),
 * onKey() — and the containers delegate clicks to them; the shim calls the
 * containers' handlers with a fake target, the way a click would arrive.
 */

import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// A giant's Warsaw office (profile.ts OFFICE_OK) passes the stack filter on purpose:
// its postings list languages ("Java, C++, Python or Go") and name no stack.
const giantInWarsaw = (job) =>
  /(?<![a-z0-9])(?:google|alphabet|youtube|deepmind|apple|netflix|meta|facebook|instagram|whatsapp|microsoft|github|linkedin|amazon|aws|nvidia)(?![a-z0-9])/i.test(job.company)
  && /warsz?aw/i.test(job.location ?? "");
const PORT = Number(process.env.TEST_PORT ?? 4399);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = join(tmpdir(), `job-hunt-test-ui-${process.pid}.db`);
// What the stand-in for `claude -p` was given, one JSON line per call.
const CLAUDE_LOG = join(tmpdir(), `job-hunt-test-ui-${process.pid}-claude.jsonl`);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/* ------------------------------------------------------------------ */
/* Minimal DOM shim                                                    */
/* ------------------------------------------------------------------ */

function makeEl(id = "") {
  return {
    id,
    innerHTML: "",
    textContent: "",
    value: "",
    title: "",
    checked: false,
    hidden: false,
    disabled: false,
    open: false,
    className: "",
    dataset: {},
    style: {},
    attributes: {},
    children: [],
    _handlers: {},
    classList: {
      _set: new Set(),
      add(name) { this._set.add(name); },
      remove(name) { this._set.delete(name); },
      toggle(name, on) { if (on) this._set.add(name); else this._set.delete(name); },
      contains(name) { return this._set.has(name); },
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    appendChild(child) { this.children.push(child); return child; },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn) { this._handlers[type] = fn; },
    focus() {},
    select() {},
    remove() {},
  };
}

function buildDocument(registry) {
  const tabs = ["search", "tracker"].map((view) => {
    const el = makeEl(`tab-${view}`);
    el.dataset.view = view;
    return el;
  });
  // The date radios are static markup, so the shim builds them once and
  // returns them by identity. Checking one clears the rest, as a browser does.
  const chips = [1, 3, 7, 14, 30].map((days) => {
    const el = makeEl(`age-${days}`);
    el.value = String(days);
    el.checked = days === 30;
    el.check = () => {
      for (const other of chips) other.checked = other === el;
      return el._handlers.change?.();
    };
    return el;
  });
  const handlers = {};
  return {
    document: {
      body: makeEl("body"),
      getElementById: (id) => registry.get(id) ?? makeEl(id),
      createElement: () => makeEl(),
      execCommand: () => true,
      querySelectorAll: (selector) => {
        if (selector === ".tab") return tabs;
        if (selector === "#datefilter input[type=radio]") return chips;
        return [];
      },
      querySelector: (selector) => (selector === '.tab[data-view="search"]' ? tabs[0] : null),
      addEventListener(type, fn) { handlers[type] = fn; },
    },
    tabs,
    chips,
    handlers,
  };
}

/** A click as a delegated handler sees it: a target whose closest("[data-x]") finds the button. */
function clickIn(registry, id, data) {
  const camel = (attr) => attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  const target = {
    closest: (selector) => {
      const match = /^\[data-([a-z-]+)\]$/.exec(selector);
      return match && camel(match[1]) in data ? { dataset: data, disabled: false } : null;
    },
  };
  return registry.get(id)._handlers.click({ target });
}

/** A key press as onKey sees it. */
const key = (code, tagName = "BODY") => ({ code, key: code, target: { tagName }, preventDefault() {} });

/* ------------------------------------------------------------------ */
/* Server lifecycle                                                    */
/* ------------------------------------------------------------------ */

/**
 * Spawns node directly on tsx's CLI rather than going through `npx`/a shell:
 * with `shell: true`, kill() terminates the shell and leaves the server running
 * as an orphan that the next run then tests by mistake.
 */
function startDashboard() {
  const tsxCli = join("node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsxCli, "src/dashboard.ts"], {
    // LinkedIn is most of a live search's wall clock; this suite opts out.
    env: {
      ...process.env,
      JOBHUNT_DB: DB,
      JOBHUNT_PORT: String(PORT),
      JOBHUNT_SOURCES: "indeed,himalayas",
      // Claude's verdicts: never the real one, and nothing in the background —
      // a test run must not spend the subscription on live postings.
      JOBHUNT_CLAUDE: join(process.cwd(), "tests", "fake-claude.mjs"),
      JOBHUNT_CLAUDE_AUTO: "0",
      FAKE_CLAUDE_LOG: CLAUDE_LOG,
      // «Подать» opens the contact it finds in the browser: never from a test.
      JOBHUNT_NO_BROWSER: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    if (/error|Error/.test(text)) process.stderr.write(`  [dashboard] ${text}`);
  });
  return child;
}

/** Refuse to run against something we did not start — see startDashboard. */
async function portIsFree() {
  try {
    await fetch(`${BASE}/api/stats`, { signal: AbortSignal.timeout(1500) });
    return false;
  } catch {
    return true;
  }
}

async function waitForServer(child, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false; // died on startup
    try {
      const response = await fetch(`${BASE}/api/stats`);
      if (response.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

const post = (path, body, method = "POST") => fetch(`${BASE}${path}`, {
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/* ------------------------------------------------------------------ */

async function main() {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });

  if (!(await portIsFree())) {
    console.log(`FAIL  something is already listening on ${PORT}. Stop it (or set TEST_PORT) — `
      + "otherwise this would test that server against a different database.");
    process.exit(1);
  }

  const server = startDashboard();
  process.on("exit", () => {
    server.kill();
    rmSync(CLAUDE_LOG, { force: true });
    // Best effort: on Windows the child may hold the database for a moment.
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(DB + suffix, { force: true }); } catch { /* next run removes it */ }
    }
  });
  if (!(await waitForServer(server))) {
    console.log("FAIL  dashboard did not start");
    process.exit(1);
  }

  /* ---- the browser is not trusted: cross-site writes are refused ---- */
  const plain = await fetch(`${BASE}/api/dismissed`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: "https://evil.example" },
    body: JSON.stringify({ url: "https://example.com/evil" }),
  });
  check("a text/plain write (a CORS simple request) is refused", plain.status === 415, String(plain.status));
  const crossSite = await fetch(`${BASE}/api/dismissed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ url: "https://example.com/evil" }),
  });
  check("a JSON write from another origin is refused", crossSite.status === 403, String(crossSite.status));
  const rebound = await new Promise((resolve, reject) => {
    const req = httpRequest(`${BASE}/api/stats`, { headers: { Host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  check("a request for another host name (DNS rebinding) is refused", rebound === 403, String(rebound));
  check("nothing was written by them", (await (await fetch(`${BASE}/api/dismissed`)).json()).dismissed.length === 0);

  /* ---- seed through the real API, so no schema is duplicated here ---- */
  for (const job of [
    { url: "https://example.com/seed/1", title: "Senior Frontend Engineer", company: "Alpha" },
    { url: "https://example.com/seed/2", title: "Senior AI Engineer", company: "Beta" },
    { url: "https://example.com/seed/3", title: "Fullstack Developer", company: "Gamma" },
  ]) await post("/api/applications", job);
  // One stale row, so the ghosted styling has something to render.
  const raw = new Database(DB);
  raw.prepare("UPDATE applications SET status='applied', applied_at=?, response_at=NULL WHERE url=?")
    .run(new Date(Date.now() - 40 * 86_400_000).toISOString(), "https://example.com/seed/3");
  raw.close();

  /* ---- the page itself ---- */
  const html = await (await fetch(`${BASE}/`)).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  check("page serves an inline script", Boolean(script));
  const js = script[1];
  try {
    new Function(js);
    check("inline JS parses", true, `${js.length} chars`);
  } catch (error) {
    check("inline JS parses", false, error.message);
    console.log("\nThe page script is a syntax error — everything below would fail.");
    process.exit(1);
  }
  check("every placeholder is filled in, the ones in comments included",
    !html.includes("__STATUSES__") && !html.includes("__SOURCES__"));
  check("nothing is loaded from off this machine", !/(src|href)="https?:\/\//.test(html.replace(/href="https:\/\/(www\.linkedin\.com|github\.com|perchusha\.github\.io)[^"]*"/g, "")));
  check("the font stack is Onest, with Unbounded for display",
    html.includes('"Onest", "Segoe UI", system-ui, sans-serif') && html.includes('"Unbounded", "Onest"'));
  const fonts = await fetch(`${BASE}/fonts.css`);
  const fontCss = await fonts.text();
  check("both bundled font families are served",
    fonts.ok && fontCss.includes("font-family: 'Onest'") && fontCss.includes("font-family: 'Unbounded'"));
  check("with their Cyrillic subsets", /U\+0400-045F/.test(fontCss));
  const fontPath = fontCss.match(/url\((\/fonts\/[^)]+)\)/)?.[1];
  const fontFile = fontPath ? await fetch(BASE + fontPath) : null;
  check("font files are served as local woff2", fontFile?.ok === true && fontFile.headers.get("content-type") === "font/woff2");
  check("Pico is gone", !html.includes("/pico.css") && (await fetch(`${BASE}/pico.css`)).status === 404);
  check("the search is a stack: stacks, a queue and one card",
    html.includes('id="stacks"') && html.includes('id="queue"') && html.includes('id="focus"'));
  check("the header keeps all three copy-link actions",
    html.includes('id="copy-linkedin"') && html.includes('id="copy-github"') && html.includes('id="copy-portfolio"'));
  check("applied jobs are hidden by default", html.includes('id="hideApplied" checked'));
  check("dark only: no light theme and nothing to switch it with",
    html.includes("color-scheme: dark") && !html.includes('data-theme="light"') && !html.includes('id="themepick"') && !html.includes("theme-boot"));
  check("Настройки open from the avatar and from the rail's foot, with a Claude section",
    html.includes('class="avatar" id="opensettings"') && html.includes('id="railsettings"')
      && html.includes('id="cl-auto"') && html.includes('id="cl-model"') && html.includes('id="cl-daily"'));
  check("the stacks sit in the middle of the header, Отклики' statuses in the same place",
    html.includes('class="segbar" id="stacks"') && html.includes('class="segbar" id="statuspills"'));
  check("the queue is a strip that scrolls inside itself, the posting has its own scroller",
    html.includes('id="queue" class="qlist fades"') && html.includes('class="scroller fades-lg" id="scroller"'));
  check("no scrollbar anywhere; a list that goes on fades at its foot",
    html.includes("* { scrollbar-width: none; }") && /\.fades, \.fades-lg \{ mask-image/.test(html) && html.includes("animation-timeline: scroll(self)"));
  check("the dock floats over the posting, outside its scroller",
    html.includes('class="dock" id="dock"') && /\.dock \{ position: absolute/.test(html));
  check("a rail holds the two sections, and Настройки at its foot",
    html.includes('id="rail"') && (html.match(/class="tab[^"]*" data-view=/g) || []).length === 2
      && html.includes('class="railbtn" id="railsettings"') && !html.includes('id="boards"'));
  check("no native select is drawn: each is a button with its options in one shared listbox",
    !/<select[\s>]/.test(html) && (html.match(/class="select[^"]*" id="[^"]+" data-select=/g) || []).length === 6 && html.includes('id="selpop" role="listbox"'));
  check("Настройки → Claude has the re-judge choice and the criteria history",
    html.includes('id="cl-rejudge"') && html.includes('id="cl-history"'));
  check("every checkbox is drawn: the real input, then its box or switch",
    (html.match(/<input type="checkbox"/g) || []).length > 0 && (html.match(/<input type="checkbox"[^>]*>(?!<i[ >])/g) || []).length === 0);
  check("Найти is an icon in the header, with its dialog and a right-click menu beside it — and no key is drawn anywhere",
    /<button class="iconbtn" id="findbtn"[^>]*data-tip="Найти"/.test(html) && html.includes('id="jump"') && html.includes('id="ctx"')
      && !html.includes("<kbd>"));
  check("a copied link says so under its own button", html.includes('data-copied="LinkedIn скопирован"') && /\.copy\.is-copied::after/.test(html));
  const avatar = await fetch(`${BASE}/avatar.jpg`);
  check("the header's avatar is the picture served from the project, not initials",
    html.includes('<img src="/avatar.jpg"') && !html.includes(">АП</button>") && avatar.ok
      && avatar.headers.get("content-type") === "image/jpeg" && (await avatar.arrayBuffer()).byteLength > 1000);

  /* ---- evaluate it against the shim ---- */
  const registry = new Map();
  for (const id of [
    "searchcount", "trackercount", "freshness", "searchbtn", "linksbtn", "linksmenu", "searchprogress",
    "needsyou", "stacks", "progresstext", "progressfill", "claudeline", "filtersbtn", "filterdot", "filters",
    "jobsearch", "datefilter", "sourcefilter", "hideApplied", "showDismissed", "dismissedCount", "showRuleHidden",
    "ruleHiddenCount", "jobsort", "queue", "queuemore", "focus", "keyhint", "view-search", "view-tracker",
    "trackertitle", "trackersub", "cards", "funnel", "legend", "applicationcount", "appsearch", "statuspills",
    "rows", "empty", "applypanel", "toast", "copy-linkedin", "copy-github", "copy-portfolio",
    "opensettings", "settings", "settingssave", "settingssaved", "themepick", "cl-auto", "cl-model", "cl-effort",
    "cl-daily", "cl-stat", "cl-now", "appsettings", "toastwarn", "opennotif", "app-test", "app-log",
    "findbtn", "jump", "jumpq", "jumplist", "ctx", "ctxsub", "selpop", "tip",
    "cl-rejudge", "cl-soft", "cl-crit", "cl-history", "cl-eval", "cl-eval-labels", "cl-eval-border", "cl-misses",
    "pref-floor", "pref-uop-gross", "pref-uop-b2b", "pref-hours", "pref-derived", "pref-companies", "pref-cities", "pref-polish",
    "rules-list", "rules-freed", "rules-fit",
    "pref-memory", "mem-companies", "mem-roles-stat", "mem-roles", "mem-forgotten", "mem-boards-stat", "mem-boards",
    "search-setup", "search-funnel", "search-queries", "search-boards",
    "dock", "side", "sidecol", "scroller", "drawer", "trackerside", "setnav", "setnav-app", "railsettings", "secs",
  ]) registry.set(id, makeEl(id));
  registry.get("settings").hidden = true;
  registry.get("hideApplied").checked = true;
  registry.get("copy-linkedin").dataset = { label: "LinkedIn", url: "https://www.linkedin.com/in/anton-perch-768578113/" };
  registry.get("copy-github").dataset = { label: "GitHub", url: "https://github.com/Perchusha" };
  registry.get("copy-portfolio").dataset = { label: "Portfolio", url: "https://perchusha.github.io/portfolio/" };

  const { document, tabs, chips } = buildDocument(registry);
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const copiedLinks = [];
  const navigator = { clipboard: { writeText: async (text) => copiedLinks.push(text) } };
  // NOTE: never overwrite globalThis timers here — undici's fetch needs them.
  const page = new Function(
    "document", "fetch", "setInterval", "setTimeout", "clearTimeout", "navigator", "location",
    `${js}
     ; return {
       load, runSearch, showView, renderRows, renderSearch, esc, act, pickStack, pickJob, onKey, pollVerdicts,
       setStatus, stackJobs, sortedApplications, openSettings, saveSettings, closeSettings, judgeRemaining,
       jumpResults, jobMenu, renderApplyPanel, onApplyPanel, saveFilters, restoreFilters,
       get applyState(){ return applyState },
       get applications(){ return applications },
       get trackedUrls(){ return trackedUrls },
       get searchResults(){ return searchResults },
       get currentKey(){ return currentKey },
       get stack(){ return stack },
       get decided(){ return decided },
       get hideOpen(){ return hideOpen },
       get claudeStatus(){ return claudeStatus },
       setPayload(payload){ lastSearchPayload = payload; searchLoaded = true; currentKey = null; decided.clear();
         hideOpen = false; stack = "good"; renderSearch(); },
       setVar(name, value){ eval(name + " = value"); },
       getVar(name){ return eval(name); },
       setSort(k, d){ sort = { key: k, dir: d } },
     };`,
  )(document, (path, init) => nativeFetch(BASE + path, init), () => 0, () => 0, () => {}, navigator, undefined);

  await registry.get("copy-linkedin")._handlers.click();
  await registry.get("copy-github")._handlers.click();
  await registry.get("copy-portfolio")._handlers.click();
  check("contact links copy their exact URLs", copiedLinks.join("|") === [
    "https://www.linkedin.com/in/anton-perch-768578113/", "https://github.com/Perchusha", "https://perchusha.github.io/portfolio/",
  ].join("|"));
  check("a copied link ticks its own button instead of a toast",
    registry.get("copy-linkedin").classList.contains("is-copied") && registry.get("toast").textContent === "");
  check("the page opens on Search", registry.get("view-search").hidden === false && registry.get("view-tracker").hidden === true);

  /* ---- attempts that need me ---- */
  await post("/api/attempts", { url: "https://example.com/attempt/1", company: "Omega",
    title: "Senior Frontend Engineer", result: "needs-code", applyUrl: "https://example.com/attempt/1/apply" });
  await post("/api/attempts", { url: "https://example.com/attempt/1", company: "Omega",
    title: "Senior Frontend Engineer", result: "captcha" });
  await page.load();
  const needs = registry.get("needsyou");
  check("an unfinished application is listed under «нужно вам»",
    needs.hidden === false && needs.innerHTML.includes("Omega") && needs.innerHTML.includes("Нужно вам: 1"), needs.innerHTML.slice(0, 100));
  check("only its latest attempt is shown, with the number of tries",
    needs.innerHTML.includes("капча") && needs.innerHTML.includes("попыток: 2"));
  await post("/api/applications", { url: "https://example.com/attempt/1?utm_source=x", title: "Senior Frontend Engineer", company: "Omega" });
  check("applying to it closes the attempt", (await (await fetch(`${BASE}/api/attempts`)).json()).attempts.length === 0);
  const omega = (await (await fetch(`${BASE}/api/applications`)).json()).applications.find((a) => a.company === "Omega");
  if (omega) new Database(DB).prepare("DELETE FROM applications WHERE id = ?").run(omega.id);

  /* ---- "Подать": only for a stored posting ---- */
  const applyUnknown = await post("/api/apply", { key: "example.com/not-in-the-store" });
  check("«Подать» for a job that is not in the stored postings is refused", applyUnknown.status === 404, String(applyUnknown.status));

  /* ---- Отклики ---- */
  await page.load();
  page.showView("tracker");
  check("the Отклики tab reveals the tracker", registry.get("view-tracker").hidden === false && tabs[1].classList.contains("is-active"));
  check("the tracker loads its rows", page.applications.length === 3, `${page.applications.length} rows`);
  check("the headline counts applications and replies, in Russian",
    registry.get("trackertitle").textContent === "3 отклика, 0 ответов", registry.get("trackertitle").textContent);
  check("six figures on tiles", (registry.get("cards").innerHTML.match(/class="tile"/g) || []).length === 6);
  check("the bar and its legend say where applications are",
    registry.get("legend").innerHTML.includes("Ждут ответа · 2") && registry.get("legend").innerHTML.includes("Без ответа · 1"),
    registry.get("legend").innerHTML.replace(/<[^>]+>/g, " ").slice(0, 120));
  const rowsHtml = registry.get("rows").innerHTML;
  check("a row per application", (rowsHtml.match(/<tr/g) || []).length === 3);
  check("the ghosted one is marked", rowsHtml.includes('class="is-ghosted"'));
  check("each row's status is its own select, in words", (rowsHtml.match(/<button type="button" class="select status" data-select="status"/g) || []).length === 3
    && rowsHtml.includes(">ждём ответа<") && rowsHtml.includes('data-s="ghosted"') && rowsHtml.includes('aria-label="Статус: Alpha: ждём ответа"'));
  check("status pills with counts", registry.get("statuspills").innerHTML.includes('data-status="applied"')
    && registry.get("statuspills").innerHTML.includes("Все <span class=\"n\">3</span>"));
  clickIn(registry, "statuspills", { status: "applied" });
  check("a status pill narrows the list", (registry.get("rows").innerHTML.match(/<tr/g) || []).length === 2);
  clickIn(registry, "statuspills", { status: "open" });
  check("«В работе» is exactly the still-alive rows", (registry.get("rows").innerHTML.match(/<tr/g) || []).length === 2);
  clickIn(registry, "statuspills", { status: "" });
  registry.get("appsearch")._handlers.input({ target: { value: "alpha" } });
  check("the search narrows by company, role or place", (registry.get("rows").innerHTML.match(/<tr/g) || []).length === 1
    && registry.get("applicationcount").textContent === "1 из 3");
  registry.get("appsearch")._handlers.input({ target: { value: "" } });
  page.setSort("company", "asc");
  const asc = page.sortedApplications().map((row) => row.company).join(",");
  page.setSort("company", "desc");
  check("sorting reverses", asc !== page.sortedApplications().map((row) => row.company).join(","));
  const alpha = page.applications.find((a) => a.company === "Alpha");
  await page.setStatus(alpha.id, "interview");
  check("changing a status in the dropdown is saved",
    page.applications.find((a) => a.company === "Alpha").status === "interview"
      && registry.get("legend").innerHTML.includes("В процессе · 1"));
  await page.setStatus(alpha.id, "applied");
  check("the tracker's right column sums it up: totals, this week",
    registry.get("trackerside").innerHTML.includes("Итоги") && registry.get("trackerside").innerHTML.includes("Эта неделя"));
  clickIn(registry, "rows", { app: String(alpha.id) });
  const drawer = registry.get("drawer");
  check("a row opens its application in the drawer: its status, when, whom I wrote to",
    drawer.hidden === false && drawer.innerHTML.includes("<h2>Alpha</h2>") && drawer.innerHTML.includes('data-select="status"')
      && drawer.innerHTML.includes("Отправлен") && drawer.innerHTML.includes("Кому писал"), drawer.innerHTML.slice(0, 160));
  check("and its row is marked open", registry.get("rows").innerHTML.includes('is-open" data-app="' + alpha.id + '"'));
  page.onKey(key("Escape"));
  check("Escape closes the drawer", drawer.hidden === true);
  page.showView("search");

  /* ---- Search: a stack, one card at a time (synthetic jobs, no boards) ---- */
  const today = new Date().toISOString();
  const verdict = (v, score, extra = {}) => ({
    verdict: v, score, summary: `Сводка ${v}`, matches: ["React и TypeScript"], concerns: ["зарплата не указана"],
    dealbreakers: v === "skip" ? ["Гибрид: «3 days in office»"] : [], hideReason: v === "skip" ? "не remote" : "",
    workMode: v === "skip" ? "hybrid" : "remote", workModeQuote: v === "skip" ? "3 days in office" : "Fully remote", salary: "",
    mainStack: ["React", "TypeScript"], seniority: "senior", canWorkFromPoland: "yes",
    at: today, model: "claude-sonnet-5-5", stale: false, session: true, ...extra,
  });
  const job = (id, company, title, extra = {}) => ({
    key: `example.com/stack/${id}`, applyUrl: `https://example.com/stack/${id}`, company, title, source: "indeed",
    location: "Remote, PL", salary: null, postedAt: today, tags: [], fit: 9, match: { level: "high", reason: "" },
    eligibility: { level: "high", reason: "Open in Poland" }, workMode: null, signals: {}, belowSalaryFloor: false,
    firstSeenAt: today, dismissed: false, screen: { bucket: "apply", reason: "", flags: [] }, verdict: null, ...extra,
  });
  const synthetic = () => ({
    jobs: [
      job("a", "Acme", "Senior React Engineer", { verdict: verdict("apply", 86), screen: { bucket: "apply", reason: "", flags: ["откликался сюда 1× (#7 rejected)"] } }),
      job("b", "Bolt", "Senior Frontend Engineer", { verdict: verdict("apply", 80) }),
      job("c", "Cirrus", "Fullstack Engineer", { verdict: verdict("maybe", 60) }),
      job("d", "Delta", "Frontend Engineer (Hybrid)", { verdict: verdict("skip", 20) }),
      job("e", "Echo", "Mid Frontend Developer", { screen: { bucket: "dismiss", reason: "mid-level role, CV is senior", flags: [] } }),
      job("f", "Foxtrot", "Senior Web Engineer"),
      job("g", "Golf", "Senior UI Engineer", { dismissed: true, verdict: verdict("apply", 75) }),
    ],
    counts: {}, profile: { hoursOld: 720 }, dismissedCount: 1,
  });
  page.setPayload(synthetic());
  const stacksHtml = () => registry.get("stacks").innerHTML;
  const focus = () => registry.get("focus").innerHTML;
  const queue = () => registry.get("queue").innerHTML;
  const dock = () => registry.get("dock").innerHTML;
  const side = () => registry.get("side").innerHTML;
  const reversed = synthetic();
  reversed.jobs.reverse();
  page.setPayload(reversed);
  check("by default the queue goes best to worst by Claude's score, whatever order the profile ranked",
    page.stackJobs("all").map((j) => j.key.split("/").pop()).join("") === "abcf",
    page.stackJobs("all").map((j) => j.key.split("/").pop()).join(""));
  page.setPayload(synthetic());
  check("stacks count what Claude said",
    stacksHtml().includes('data-stack="good" aria-pressed="true">Подходят <span class="n">2</span>')
      && stacksHtml().includes('Проверить <span class="n">1</span>')
      && stacksHtml().includes('Все <span class="n">4</span>')
      && stacksHtml().includes('Убрал Claude <span class="n">1</span>'), stacksHtml().replace(/<[^>]+>/g, " "));
  check("«Почти подошли» holds the skips scored 20 or more, still inside «Убрал Claude»",
    stacksHtml().includes('Почти подошли <span class="n">1</span>') && page.stackJobs("near").map((j) => j.company).join() === "Delta");
  const softenedPayload = synthetic();
  softenedPayload.jobs = [job("s", "Sierra", "Senior Frontend Engineer",
    { verdict: verdict("maybe", 25, { dealbreakers: ["Гибрид: «3 days in office»"], softened: ["format"] }) })];
  page.setPayload(softenedPayload);
  clickIn(registry, "stacks", { stack: "maybe" });
  check("a softened skip sits in «Проверить» and says why it is there",
    page.stackJobs("maybe").length === 1 && focus().includes("Claude убрал бы её (формат)") && focus().includes("✕ Гибрид"),
    page.stack + " " + focus().replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 400));
  clickIn(registry, "stacks", { stack: "good" });
  page.setPayload(synthetic());
  check("the first card is the best one in the stack", page.currentKey === "example.com/stack/a" && focus().includes("Senior React Engineer"));
  check("the card says the verdict, the facts, the stack and Claude's summary",
    focus().includes("Подходит · 86") && focus().includes("«Fully remote»") && focus().includes(">Из Польши<")
      && focus().includes('<span class="tag">React</span>') && focus().includes("Сводка apply"));
  check("an earlier application at the company is in the right column, not on the card",
    /откликался сюда 1×/i.test(side()) && !focus().includes("откликался"));
  check("the right column says what is known around it: the company, its copies, the rules",
    side().includes("История с компанией") && side().includes("Копии на площадках") && side().includes("Только на Indeed")
      && side().includes("Правила"));
  check("four actions in the dock, and no key drawn",
    ["hide", "funnel", "discuss", "apply"].every((a) => dock().includes(`data-act="${a}"`)) && !dock().includes('data-act="later"')
      && !dock().includes("<kbd>") && !focus().includes("<kbd>"));
  check("the strip lists the stack, the current one marked",
    (queue().match(/class="q/g) || []).length === 2 && queue().includes('class="q is-on" data-key="example.com/stack/a"'));
  check("progress reads 1 / 2", registry.get("progresstext").textContent === "1 / 2");
  check("each tile is Claude's score, in the verdict's colour — no company letters",
    queue().includes('<span class="pts apply" aria-hidden="true">86</span>') && !queue().includes(">Ac<") && !queue().includes('class="mono'));
  check("the strip shows only scores; a tile names its posting for the ear and on hover",
    queue().includes('aria-label="Senior React Engineer — Acme, Подходит, 86" data-tip="Senior React Engineer · Acme"') && !queue().includes(">Acme<"));

  /* ---- Ctrl K, the right-click menu ---- */  const jumpTo = (q) => page.jumpResults(q).map((item) => item.kind + ":" + item.label);
  check("Ctrl K with nothing typed offers what is next in the stack, then the stacks",
    jumpTo("")[0] === "job:Senior React Engineer" && jumpTo("").includes("stack:Проверить"), jumpTo("").join(", "));
  check("«#» finds a stack, «@» a company", jumpTo("#пров").join() === "stack:Проверить"
    && jumpTo("@bolt")[0] === "job:Senior Frontend Engineer", jumpTo("@bolt").join(", "));
  check("a plain query finds postings by title", jumpTo("fullstack").includes("job:Fullstack Engineer"));
  const delta = page.searchResults.find((j) => j.company === "Delta");
  const deltaHide = page.jobMenu(delta).find((item) => item.label === "Скрыть");
  check("the right-click menu hides with a reason, Claude's own first",
    deltaHide?.sub?.[0]?.label === "Claude: не remote" && deltaHide.sub.at(-1).label === "Просто скрыть");
  const acmeMenu = page.jobMenu(page.searchResults.find((j) => j.company === "Acme"));
  check("and offers the card's actions — no keys, no «Потом»",
    ["Подать", "В воронку", "Обсудить с Claude"].every((label) => acmeMenu.some((item) => item.label === label && !item.disabled))
      && !acmeMenu.some((item) => item.label === "Потом") && acmeMenu.every((item) => !item.key)
      && acmeMenu.some((item) => item.label === "Копировать ссылку"));
  check("the card links to the posting on its board; the menu leaves that to «Подать»",
    focus().includes("Открыть на площадке") && !acmeMenu.some((item) => item.label === "Открыть вакансию"));

  page.onKey(key("ArrowDown"));
  check("↓ walks the queue without deciding anything", page.currentKey === "example.com/stack/b" && page.decided.size === 0);
  page.onKey(key("Enter", "BUTTON"));
  check("Enter on a focused button is that button's, not «Подать»", page.decided.size === 0);
  for (const code of ["KeyH", "KeyF", "KeyC", "ArrowRight", "Digit1"]) page.onKey(key(code));
  page.onKey({ code: "KeyK", key: "k", ctrlKey: true, target: { tagName: "BODY" }, preventDefault() {} });
  check("only Enter and the arrows are keys: H, F, C, →, digits and Ctrl K do nothing",
    page.decided.size === 0 && !page.hideOpen && page.currentKey === "example.com/stack/b" && page.getVar("jumpOpen") === false);
  clickIn(registry, "queue", { key: "example.com/stack/a" });
  check("a tile opens its card", page.currentKey === "example.com/stack/a" && focus().includes("Senior React Engineer"));
  clickIn(registry, "queue", { key: "example.com/stack/b" });

  await page.act("hide");
  check("«Скрыть» opens the reasons over the dock, the page's own one-click ones", page.hideOpen && dock().includes('data-reason="не тот стек"')
    && !dock().includes("Claude предлагает"));
  page.onKey(key("Escape"));
  check("Escape closes them", !page.hideOpen);

  await page.act("funnel");
  check("«В воронку» records the application and moves on", page.trackedUrls.has("example.com/stack/b")
    && page.decided.get("example.com/stack/b") === "funnel" && page.currentKey === "example.com/stack/a");
  check("the decided tile keeps its place in the strip, marked", queue().includes(">в воронке<") && (queue().match(/class="q/g) || []).length === 2);
  check("and the tracker got the row", page.applications.some((a) => a.url === "https://example.com/stack/b"));

  clickIn(registry, "stacks", { stack: "skipped" });
  check("«Убрал Claude» holds Claude's skips", page.stack === "skipped" && page.currentKey === "example.com/stack/d"
    && focus().includes("✕ Гибрид: «3 days in office»"));
  await page.act("hide");
  check("a skip's reasons start with Claude's own", dock().indexOf("Claude предлагает: не remote") > -1
    && dock().indexOf("Claude предлагает") < dock().indexOf('data-reason="не тот стек"'));
  clickIn(registry, "dock", { act: "reason", reason: "не remote" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const hidden = (await (await fetch(`${BASE}/api/dismissed`)).json()).dismissed.find((d) => d.url === "https://example.com/stack/d");
  check("a reason hides it with that reason", hidden?.reason === "не remote", JSON.stringify(hidden));
  check("an emptied stack says so, with what happened", focus().includes("Эта стопка разобрана") && focus().includes("скрыто: 1"));

  page.pickStack("all");
  check("«Все» has the unjudged ones too, with a way to ask",
    page.stackJobs("all").some((j) => j.company === "Foxtrot") && (page.pickJob("example.com/stack/f"), focus().includes('data-act="ask"')));
  check("a rule hit stays out unless asked for", !page.stackJobs("all").some((j) => j.company === "Echo"));
  registry.get("showRuleHidden")._handlers.change({ target: { checked: true } });
  page.pickJob("example.com/stack/e");
  check("its toggle brings it back, with the rule's reason", focus().includes("Правило скрининга: mid-level role, CV is senior"));
  check("the reason carries «правило ошиблось», and so does the right-click menu", focus().includes('data-act="rule-wrong"')
    && page.jobMenu(page.searchResults.find((j) => j.company === "Echo")).some((item) => item.label === "Правило ошиблось"));
  await page.act("rule-wrong");
  const echo = page.searchResults.find((j) => j.company === "Echo");
  check("«правило ошиблось» lets the card into the stacks", echo.screen.bucket === "apply" && page.stackJobs("all").includes(echo)
    && /больше не прячет Echo/.test(registry.get("toast").textContent), registry.get("toast").textContent);
  await post("/api/rules/override", { key: "example.com/stack/e" }, "DELETE");
  registry.get("showRuleHidden")._handlers.change({ target: { checked: false } });
  page.setVar("showDismissed", true);
  page.renderSearch();
  page.pickJob("example.com/stack/g");
  check("a job I hid shows «Вернуть» instead of «Скрыть»", dock().includes('data-act="restore"') && !dock().includes('data-act="hide"'));
  page.setVar("showDismissed", false);
  registry.get("hideApplied")._handlers.change({ target: { checked: false } });
  page.setPayload({ ...synthetic(), jobs: synthetic().jobs });
  check("with «прятать отклики» off, an applied job is in its stack", page.stackJobs("good").some((j) => j.company === "Bolt"));
  registry.get("hideApplied")._handlers.change({ target: { checked: true } });
  check("with it on, it is not — unless decided in this session", !page.stackJobs("good").some((j) => j.company === "Bolt"));

  /* ---- Claude's verdict: asked from the card, made by the stand-in ---- */
  const posting = (id, title, text) => ({
    key: `example.com/claude-test/${id}`,
    row: {
      source: "indeed", externalId: `claude-test-${id}`, title, company: `Claudeco ${id}`,
      url: `https://example.com/claude-test/${id}`, location: "Remote, Poland", remote: true,
      salary: null, salaryMin: null, salaryMax: null, tags: [], postedAt: today, locationRestrictions: [],
      description: text,
    },
  });
  // Long enough to be used as stored: a short description sends the verdict to read the page instead.
  const filler = " You will own features end to end, from design review to production.".repeat(12);
  const fits = posting(1, "Senior React Engineer", "Fully remote. Senior React and TypeScript engineer." + filler);
  const misfit = posting(2, "Senior Frontend Engineer", "Fully remote. Angular 17, RxJS, NgRx." + filler);
  const store = new Database(DB);
  for (const { key: k, row } of [fits, misfit]) {
    store.prepare("INSERT INTO postings (source, job_key, data, posted_at, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.source, k, JSON.stringify(row), today, today, today);
  }
  store.close();

  const unknownVerdict = await post("/api/verdict", { key: "example.com/not-in-the-store" });
  check("a verdict for a job that is not stored is refused", unknownVerdict.status === 404, String(unknownVerdict.status));

  const asCard = (p) => job(p.key.split("/").pop(), p.row.company, p.row.title, { key: p.key, applyUrl: p.row.url });
  page.setPayload({ jobs: [asCard(fits), asCard(misfit)], counts: {}, profile: { hoursOld: 720 } });
  page.pickStack("all");
  check("a card without a verdict offers to ask Claude", focus().includes("Спросить Claude"));
  clickIn(registry, "focus", { act: "ask" });
  const askedMisfit = await post("/api/verdict", { key: misfit.key });
  check("asking for a stored job queues it", askedMisfit.status === 202, String(askedMisfit.status));

  let made = {};
  for (let waited = 0; waited < 20_000 && !(made[fits.key] && made[misfit.key]); waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    made = (await (await fetch(`${BASE}/api/verdicts`)).json()).verdicts;
  }
  check("the card's button and the API both got a verdict made and stored",
    Boolean(made[fits.key] && made[misfit.key]), Object.keys(made).join(", ") || "none");
  check("a fitting posting is an apply, with its score", made[fits.key]?.verdict === "apply" && made[fits.key]?.score === 90);
  check("a skip carries a hide reason from the page's own list", made[misfit.key]?.hideReason === "не тот стек");
  check("a verdict remembers its session, for «обсудить с Claude»", made[fits.key]?.session === true);
  check("and what the card's facts show", made[fits.key]?.seniority === "senior" && made[fits.key]?.mainStack?.[0] === "React");

  /* ---- «Верно» / «Мимо»: the label the criteria are checked against ---- */
  const wrong = await post("/api/verdict/feedback", { key: misfit.key, expected: "maybe" });
  const marked = (await wrong.json()).verdict;
  check("«Мимо» stores what the verdict should have been", wrong.status === 200
    && marked?.feedback?.expected === "maybe" && marked?.feedback?.verdict === "skip", JSON.stringify(marked?.feedback));
  check("a mark without a verdict, or with a word not ours, is refused",
    (await post("/api/verdict/feedback", { key: "nope", expected: "skip" })).status === 404
      && (await post("/api/verdict/feedback", { key: fits.key, expected: "great" })).status === 400);
  const evalState = await (await fetch(`${BASE}/api/criteria/check`)).json();
  check("the mark becomes a label for «Сверить с эталоном»", evalState.sizes?.labels >= 1 && evalState.running === null,
    JSON.stringify(evalState.sizes));

  const calls = readFileSync(CLAUDE_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const call = calls.find((entry) => entry.prompt.includes("Senior React Engineer"));
  const flag = (name) => call?.args[call.args.indexOf(name) + 1];
  check("claude runs headless, with no tools, no MCP servers and nothing from disk",
    Boolean(call) && call.args.includes("-p") && call.args.includes("--tools") && flag("--tools") === ""
      && call.args.includes("--strict-mcp-config") && call.args.includes("--safe-mode"), JSON.stringify(call?.args.slice(1, 13)));
  check("the answer is held to the verdict schema", (JSON.parse(flag("--json-schema") ?? "{}").required ?? []).includes("verdict"));
  check("the posting goes in on stdin, with what the board says about it",
    Boolean(call?.prompt.includes("Fully remote. Senior React")) && Boolean(call?.prompt.includes("Компания: Claudeco 1")));
  check("all of it inside <posting>, the block the system prompt calls the employer's text",
    /<posting>\n[\s\S]*Компания: Claudeco 1[\s\S]*Fully remote[\s\S]*\n<\/posting>$/.test(call?.prompt ?? ""));
  // The sessions' folder is where "обсудить" opens a session with tools; nothing a run reads lives there.
  const promptFile = String(flag("--system-prompt-file"));
  check("the system prompt is written per run outside the sessions' folder, then removed",
    dirname(promptFile) === join(dirname(DB), "verdicts-tmp") && !existsSync(promptFile), promptFile);

  page.setVar("searchLoaded", true);
  await page.pollVerdicts();
  page.pickJob(fits.key);
  check("the verdict lands on the open card", focus().includes("Подходит · 90") && focus().includes("Подходит: React"));
  check("the skip moved to «Убрал Claude»", stacksHtml().includes('Убрал Claude <span class="n">1</span>')
    && !page.stackJobs("all").some((j) => j.key === misfit.key));

  /* ---- «Подать»: whom to write to, and what — drafted by the stand-in ---- */
  const withEmail = posting(31, "Senior React Developer",
    "Fully remote. If you require interview accommodations, please email recruiting@claudeco31.example. React and TypeScript. "
      + "Privacy questions: privacy@claudeco31.example. Send your CV to jobs@claudeco31.example." + filler);
  const withPerson = posting(32, "Senior Frontend Engineer", "Fully remote. React. Contact person: Jane Doe, our recruiter." + filler);
  const withGhost = posting(33, "Frontend Engineer", "Fully remote. React. GHOST-NAME." + filler);
  const store2 = new Database(DB);
  for (const { key: k, row } of [withEmail, withPerson, withGhost]) {
    store2.prepare("INSERT INTO postings (source, job_key, data, posted_at, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.source, k, JSON.stringify(row), today, today, today);
  }
  store2.close();
  const logLines = () => readFileSync(CLAUDE_LOG, "utf8").trim().split("\n");
  const outreach = async (p) => (await post("/api/apply", { key: p.key })).json();

  const callsBefore = logLines().length;
  const nobody = await outreach(fits);
  check("a posting that names nobody: the company's recruiters in LinkedIn, opened as well",
    nobody.contact?.kind === "search" && nobody.contact.url === "https://www.linkedin.com/search/results/people/?keywords=Claudeco%201%20recruiter"
      && nobody.opened === true, JSON.stringify(nobody).slice(0, 400));
  check("a note within LinkedIn's limit, and a letter whose signature code types",
    nobody.drafted === "claude" && nobody.note.length > 0 && nobody.note.length <= 200
      && nobody.message.startsWith("Hi Claudeco 1 team,") && nobody.message.includes("Best regards,\nAnton Perch\n+48"), nobody.message);
  const outreachCall = JSON.parse(logLines().at(-1));
  const outreachFlag = (name) => outreachCall.args[outreachCall.args.indexOf(name) + 1];
  check("the run has no tools, its own schema, and the posting inside <posting>, called the employer's text",
    outreachFlag("--tools") === "" && outreachCall.args.includes("--safe-mode") && Boolean(JSON.parse(outreachFlag("--json-schema") ?? "{}").properties?.note)
      && /<posting>\n[\s\S]*Компания: Claudeco 1[\s\S]*<\/posting>/.test(outreachCall.prompt) && outreachCall.system.includes("между <posting> и </posting> — текст работодателя"));
  await outreach(fits);
  check("pressed again, the same texts and no second run", logLines().length === callsBefore + 1);

  const mail = await outreach(withEmail);
  check("an address for applications: Gmail's compose window, addressed and written, opened at once — not the privacy or accommodations box",
    mail.contact?.kind === "email" && mail.contact.label === "jobs@claudeco31.example" && mail.contact.url.includes("to=jobs%40claudeco31.example")
      && mail.contact.url.includes("su=Senior%20React%20Developer") && mail.contact.url.includes("body=Hi%20Claudeco%2031%20team") && mail.opened === true,
    JSON.stringify(mail.contact));
  const person = await outreach(withPerson);
  check("a person the posting names: LinkedIn's search for them at the company, and the note greets them",
    person.contact?.kind === "person" && person.contact.label === "Jane Doe"
      && person.contact.url.endsWith("keywords=Jane%20Doe%20Claudeco%2032") && person.opened === true && person.note.startsWith("Hi Jane,"), JSON.stringify(person.contact));
  const ghost = await outreach(withGhost);
  check("a name that is not in the posting is not a contact", ghost.contact?.kind === "search", JSON.stringify(ghost.contact));

  page.pickJob(fits.key);
  await page.act("apply");
  check("«Подать» marks the card and turns the middle into the letter: whom to write to, the note, the letter",
    page.decided.get(fits.key) === "applying" && focus().includes("Письмо человеку") && focus().includes("Записка к запросу в LinkedIn")
      && focus().includes("Поиск рекрутеров Claudeco 1 открыт в LinkedIn") && focus().includes("это поиск, а не найденный человек")
      && focus().includes("Открыть поиск ещё раз"),
    focus().replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300));
  check("the dock becomes the letter's: back to the posting, not applying, sent",
    dock().includes('data-apply="close"') && dock().includes('data-apply="skip"') && dock().includes("Отправил, в отклики"));
  check("and the right column the steps", side().includes("Как подаёмся") && side().includes("Из чего письмо"));
  await page.onApplyPanel("copy-note");
  check("copying the note ticks «Человеку написано»", page.applyState.wrote === true && copiedLinks.at(-1) === page.applyState.note);
  await page.onApplyPanel("funnel");
  const recorded = (await (await fetch(`${BASE}/api/applications`)).json()).applications.find((a) => a.company === "Claudeco 1");
  check("«Отправил, в отклики» records it, with whom I wrote to, and the letter gives way",
    recorded?.notes?.includes("outreach: search рекрутеры Claudeco 1 в LinkedIn") && page.applyState === null, recorded?.notes ?? "not recorded");
  if (recorded) new Database(DB).prepare("DELETE FROM applications WHERE id = ?").run(recorded.id);
  page.onApplyPanel("close");
  // The row is gone, so is this session's mark: the live search below starts clean.
  page.decided.delete(fits.key);
  await page.load();

  // The stand-in's session id is not on disk, so this must stop before any window opens.
  const reopen = await post("/api/verdict/open", { key: fits.key });
  check("«обсудить» refuses a session that is not on disk", reopen.status === 410, String(reopen.status));
  const noVerdict = await post("/api/verdict/open", { key: "example.com/not-in-the-store" });
  check("«обсудить» without a verdict is a 404", noVerdict.status === 404, String(noVerdict.status));

  /* ---- Настройки: Claude's settings, stored by the server, used from the next run ---- */
  const settings0 = (await (await fetch(`${BASE}/api/settings`)).json()).claude;
  const criteria0 = (await (await fetch(`${BASE}/api/settings`)).json()).criteria;
  check("the settings say where the criteria stand: the current version kept, the stale count",
    Array.isArray(criteria0?.history) && criteria0.history.some((v) => v.current && v.text.length > 0) && typeof criteria0.stale === "number",
    JSON.stringify({ versions: criteria0?.history?.length, stale: criteria0?.stale }));
  check("the settings start from the defaults (background off here, by JOBHUNT_CLAUDE_AUTO=0)",
    settings0.auto === false && settings0.model === "sonnet" && settings0.effort === "low" && settings0.daily === 80, JSON.stringify(settings0));
  await page.openSettings();
  check("«Настройки» open, filled in", registry.get("settings").hidden === false
    && registry.get("cl-model").value === "sonnet" && registry.get("cl-daily").value === "80"
    && /Сегодня в фоне: 0 из 80/.test(registry.get("cl-stat").textContent), registry.get("cl-stat").textContent);
  check("Настройки draw the rules with their switches and the company boards",
    registry.get("rules-list").innerHTML.includes('data-rule="PHP-first role"') && registry.get("mem-boards").innerHTML.includes("<b>Linear</b>"),
    registry.get("rules-list").innerHTML.slice(0, 200));
  const decidedBefore = page.decided.size;
  page.onKey(key("KeyF"));
  check("the card's keys do nothing while the settings are open", page.decided.size === decidedBefore);
  registry.get("cl-model").value = "opus";
  registry.get("cl-effort").value = "medium";
  registry.get("cl-daily").value = "25";
  await page.saveSettings();
  const settings1 = (await (await fetch(`${BASE}/api/settings`)).json()).claude;
  check("«Сохранить» stores them on the server", settings1.model === "opus" && settings1.effort === "medium" && settings1.daily === 25
    && settings1.soft === true
    && registry.get("settingssaved").textContent === "Сохранено", `${registry.get("settingssaved").textContent || registry.get("toast").textContent} ${JSON.stringify(settings1)}`);
  /* ---- «Мои условия»: one place for the floor, the offices, Polish — the criteria get them too ---- */
  const prefs0 = (await (await fetch(`${BASE}/api/settings`)).json()).preferences;
  check("«Мои условия» start from the old constants", prefs0.floorB2bPlnMonth === 25000 && prefs0.polish === "B1"
    && prefs0.officeCompanies.includes("Google") && Math.round(prefs0.derived.uopPlnMonth) === 30909, JSON.stringify(prefs0.derived));
  const raised = await post("/api/settings/preferences", { floorB2bPlnMonth: 28000, polish: "B2" });
  const raisedBody = await raised.json();
  const current = raisedBody.criteria.history.find((v) => v.current);
  check("a new floor is stored and goes into the criteria as their last section", raised.status === 200
    && raisedBody.preferences.floorB2bPlnMonth === 28000 && /от 28 000 PLN нетто/.test(current?.text ?? "") && /Польский у него B2/.test(current?.text ?? ""),
    (current?.text ?? "").slice(-300));
  check("a floor that cannot be right is refused", (await post("/api/settings/preferences", { floorB2bPlnMonth: 5 })).status === 400);
  await post("/api/settings/preferences", { floorB2bPlnMonth: 25000, polish: "B1" });

  const badSetting = await post("/api/settings/claude", { model: "gpt-5" });
  check("a model that is not one of ours is refused", badSetting.status === 400, String(badSetting.status));
  const softened = await post("/api/settings/claude", { softenFactors: ["format", "level", "format"] });
  const softenedBody = await softened.json();
  check("«Не убирать, если единственная причина» keeps the kinds once each",
    softened.status === 200 && JSON.stringify(softenedBody.claude.softenFactors) === '["format","level"]', JSON.stringify(softenedBody.claude));
  check("a kind that cannot be softened is refused — Poland, citizenship, a closed posting",
    (await post("/api/settings/claude", { softenFactors: ["poland"] })).status === 400);
  await post("/api/settings/claude", { softenFactors: [] });
  await post("/api/verdict", { key: fits.key });
  for (let waited = 0; waited < 20_000; waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const status = (await (await fetch(`${BASE}/api/verdicts`)).json()).status;
    if (status.running.length === 0 && status.queued.length === 0) break;
  }
  const lastCall = readFileSync(CLAUDE_LOG, "utf8").trim().split("\n").map((line) => JSON.parse(line)).pop();
  const lastFlag = (name) => lastCall?.args[lastCall.args.indexOf(name) + 1];
  check("the next run uses them — no restart", lastFlag("--model") === "opus" && lastFlag("--effort") === "medium",
    JSON.stringify({ model: lastFlag("--model"), effort: lastFlag("--effort") }));
  await post("/api/settings/claude", { model: "sonnet", effort: "low", daily: 80 });
  page.onKey(key("Escape"));
  check("Escape closes the settings", registry.get("settings").hidden === true);

  // Last of the verdict checks: the limit pauses the queue for the rest of this run.
  const limited = posting(3, "Senior Web Engineer", "Fully remote. LIMIT-TEST." + filler);
  const limitStore = new Database(DB);
  limitStore.prepare("INSERT INTO postings (source, job_key, data, posted_at, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)")
    .run(limited.row.source, limited.key, JSON.stringify(limited.row), today, today, today);
  limitStore.close();
  await post("/api/verdict", { key: limited.key });
  let paused = null;
  for (let waited = 0; waited < 20_000 && !paused?.pausedUntil; waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    paused = (await (await fetch(`${BASE}/api/verdicts`)).json()).status;
  }
  check("the plan's usage limit pauses the whole queue until it resets",
    Boolean(paused?.pausedUntil) && /^лимит Claude до \d\d:\d\d$/.test(paused?.pauseReason ?? ""),
    JSON.stringify({ until: paused?.pausedUntil, reason: paused?.pauseReason }));
  check("and is not held against the posting: it waits in the queue, with no failure",
    (paused?.queued ?? []).includes(limited.key) && !(paused?.failures ?? {})[limited.key]);
  // Paused now, so what this queues waits instead of running.
  const remaining = await post("/api/verdicts/queue", { scope: "missing" });
  const remainingBody = await remaining.json();
  check("«Оценить оставшиеся сейчас» queues the shown cards without a verdict",
    remaining.status === 202 && typeof remainingBody.queued === "number", JSON.stringify({ queued: remainingBody.queued }));

  /* ---- Настройки → Правила: what each rule hides, a switch, «Правило ошиблось» ---- */
  const midRole = posting(4, "Regular React Developer", "Fully remote. React and TypeScript." + filler);
  const ruleStore = new Database(DB);
  ruleStore.prepare("INSERT INTO postings (source, job_key, data, posted_at, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)")
    .run(midRole.row.source, midRole.key, JSON.stringify(midRole.row), today, today, today);
  ruleStore.close();
  // A save rebuilds the feed, as a refresh does: the posting above is then in it.
  await post("/api/settings/preferences", { rulesOff: [] });
  const MID = "mid-level role, CV is senior";
  const midRow = async () => (await (await fetch(`${BASE}/api/search`)).json()).jobs.find((j) => j.key === midRole.key);
  const rules0 = await (await fetch(`${BASE}/api/rules`)).json();
  const midRule = rules0.rules?.find((rule) => rule.id === MID);
  check("Настройки → Правила list every rule: its name, its words, what it hides now",
    rules0.rules.length > 15 && midRule?.on === true && midRule.label === "Мидл" && midRule.words.includes("regular")
      && midRule.hits >= 1 && midRule.examples.some((e) => e.title === "Regular React Developer"), JSON.stringify(midRule));
  check("and what the fit gate left out, by kind", typeof rules0.fitGate?.total === "number" && rules0.fitGate.groups.length === 3);
  check("the rule hides the posting", (await midRow())?.screen?.bucket === "dismiss", JSON.stringify((await midRow())?.screen));
  const freed = await post("/api/rules/override", { key: midRole.key, reason: MID });
  const freedBody = await freed.json();
  check("«Правило ошиблось» lets it out at once", freed.status === 200 && ["apply", "check"].includes(freedBody.screen?.bucket), JSON.stringify(freedBody));
  check("and the feed agrees", ["apply", "check"].includes((await midRow())?.screen?.bucket));
  const rules1 = await (await fetch(`${BASE}/api/rules`)).json();
  check("Настройки list it under «Правило ошиблось», by the rule's name",
    rules1.overrides.some((row) => row.job_key === midRole.key && row.label === "Мидл"), JSON.stringify(rules1.overrides));
  await post("/api/rules/override", { key: midRole.key }, "DELETE");
  check("«вернуть правилам» puts it back under the rule", (await midRow())?.screen?.bucket === "dismiss");
  const switched = await post("/api/settings/preferences", { rulesOff: [MID] });
  check("a rule switched off stops hiding", switched.status === 200 && ["apply", "check"].includes((await midRow())?.screen?.bucket));
  const midOff = (await (await fetch(`${BASE}/api/rules`)).json()).rules.find((rule) => rule.id === MID);
  check("and says what it would hide again", midOff?.on === false && midOff.hits >= 1, JSON.stringify(midOff));
  check("a rule that does not exist cannot be switched off",
    (await post("/api/settings/preferences", { rulesOff: ["no such rule"] })).status === 400);
  await post("/api/settings/preferences", { rulesOff: [] });

  /* ---- Настройки → Компании и память: what my hides teach, and taking it back ---- */
  const memCopy = posting(5, "Senior Frontend Engineer, Payments", "Fully remote. React and TypeScript." + filler);
  await post("/api/dismissed", { url: "https://example.com/mem/old", title: memCopy.row.title, company: memCopy.row.company, reason: "не remote" });
  const memStore = new Database(DB);
  memStore.prepare("INSERT INTO postings (source, job_key, data, posted_at, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)")
    .run(memCopy.row.source, memCopy.key, JSON.stringify(memCopy.row), today, today, today);
  memStore.close();
  await post("/api/settings/preferences", { memoryDays: 0 });
  const memRow = async () => (await (await fetch(`${BASE}/api/search`)).json()).jobs.find((j) => j.key === memCopy.key);
  check("an earlier hide hides the copy of its role", /^same role hidden earlier/.test((await memRow())?.screen?.reason ?? ""),
    JSON.stringify((await memRow())?.screen));
  const memory0 = await (await fetch(`${BASE}/api/memory`)).json();
  check("Компании и память list that hide with what it hides now, and every company board",
    memory0.roles?.some((row) => row.key === "example.com/mem/old" && row.hides === 1) && memory0.boards?.some((b) => b.company === "Linear")
      && typeof memory0.remembered === "number", JSON.stringify(memory0.roles));
  await post("/api/memory/forget", { kind: "hide", key: "example.com/mem/old", label: "Payments · Claudeco 5" });
  check("«забыть»: the hide stops teaching, the copy shows", ["apply", "check"].includes((await memRow())?.screen?.bucket));
  check("and it is listed as forgotten", (await (await fetch(`${BASE}/api/memory`)).json()).forgotten
    .some((row) => row.kind === "hide" && row.key === "example.com/mem/old"));
  await post("/api/memory/forget", { kind: "hide", key: "example.com/mem/old" }, "DELETE");
  check("«вспомнить» brings it back", /^same role hidden earlier/.test((await memRow())?.screen?.reason ?? ""));
  check("only companies and hides can be forgotten", (await post("/api/memory/forget", { kind: "rule", key: "x" })).status === 400);
  check("the memory window takes 0 to 730 days", (await post("/api/settings/preferences", { memoryDays: 45 })).status === 200
    && (await post("/api/settings/preferences", { memoryDays: 999 })).status === 400);
  await post("/api/settings/preferences", { memoryDays: 0 });

  /* ---- Фильтры survive a reload (localStorage; absent here, so a stand-in) ---- */
  const kept = new Map();
  globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, String(v)) };
  page.setVar("maxAgeDays", 7);
  page.setVar("jobSort", "newest");
  page.setVar("hideApplied", false);
  page.saveFilters();
  page.setVar("maxAgeDays", 30);
  page.setVar("jobSort", "claude");
  page.setVar("hideApplied", true);
  page.restoreFilters();
  check("Фильтры survive a reload: the window, the order, the toggles",
    page.getVar("maxAgeDays") === 7 && page.getVar("jobSort") === "newest" && page.getVar("hideApplied") === false
      && registry.get("jobsort").value === "newest" && registry.get("hideApplied").checked === false, kept.get("jobhunt-filters"));
  kept.set("jobhunt-filters", JSON.stringify({ maxAgeDays: 99, sourcesOff: ["indeed", "himalayas"], jobSort: "nope" }));
  page.restoreFilters();
  check("a stored value that cannot be right is ignored: no 99-day window, never zero boards",
    page.getVar("maxAgeDays") === 7 && page.getVar("activeSources").size === 2 && page.getVar("jobSort") === "newest");
  delete globalThis.localStorage;
  page.setVar("maxAgeDays", 30);
  page.setVar("jobSort", "claude");
  page.setVar("hideApplied", true);
  registry.get("hideApplied").checked = true;
  for (const chip of chips) chip.checked = chip.value === "30";

  /* ---- Настройки → Поиск, read only ---- */
  const setup0 = await (await fetch(`${BASE}/api/search-setup`)).json();
  check("Настройки → Поиск: every query (and the giants' one), every board, the way from stored to shown",
    setup0.queries?.length >= 10 && setup0.queries.some((q) => q.giants) && setup0.boards?.length === 2
      && typeof setup0.funnel?.stored === "number" && setup0.funnel.stored >= setup0.funnel.deduped && setup0.funnel.deduped >= setup0.funnel.eligible,
    JSON.stringify(setup0.funnel));

  /* ---- profile search (live network) ---- */
  console.log("\n(running a live profile search through the page's own code path…)");
  await page.runSearch();

  const storedSearch = await (await fetch(`${BASE}/api/search?sources=indeed,himalayas&hoursOld=720`)).json();
  const fetchedAt = storedSearch.freshness?.sources?.indeed?.lastSuccessAt;
  check("the search reads the stored postings and says when each board was fetched",
    Boolean(fetchedAt) && Boolean(storedSearch.freshness?.sources?.himalayas?.lastSuccessAt), fetchedAt);
  check("stored postings carry when they were first seen", storedSearch.jobs.length > 0 && storedSearch.jobs.every((j) => Boolean(j.firstSeenAt)));
  const again = await (await fetch(`${BASE}/api/search?sources=indeed,himalayas&hoursOld=168`)).json();
  check("a narrower date window does not fetch the boards again", again.freshness?.sources?.indeed?.lastSuccessAt === fetchedAt);
  check("the first visit was recorded, so later postings count as new", Boolean((await (await fetch(`${BASE}/api/search`)).json()).newSince));
  const newCount = await (await fetch(`${BASE}/api/new-count`)).json();
  check("nothing is new right after a visit", newCount.count === 0, JSON.stringify(newCount));
  const setup1 = await (await fetch(`${BASE}/api/search-setup`)).json();
  check("a refresh records which query found what", setup1.queries.some((q) => q.found > 0 && q.only <= q.found),
    setup1.queries.map((q) => `${q.query}:${q.found}/${q.only}`).join(", "));
  check("no wrong-stack results, a giant's Warsaw office aside", page.searchResults.every((j) => j.fit >= 0 || giantInWarsaw(j)),
    `min fit ${Math.min(...page.searchResults.filter((j) => !giantInWarsaw(j)).map((j) => j.fit))}`);
  check("the refresh button says how fresh the boards are", /назад|только что|обновляю/.test(registry.get("freshness").textContent),
    registry.get("freshness").textContent);
  check("the source filter lists the configured boards, all on, each with its drawn box",
    (registry.get("sourcefilter").innerHTML.match(/type="checkbox"/g) || []).length === 2
      && (registry.get("sourcefilter").innerHTML.match(/ checked><i aria-hidden="true"><\/i>/g) || []).length === 2);

  page.pickStack("all");
  const liveJobs = page.stackJobs("all");
  check("live postings fill «Все», the first one on the card",
    liveJobs.length > 0 && page.currentKey === liveJobs[0].key && focus().includes('class="card'), `${liveJobs.length} in the stack`);

  /* ---- add to funnel from the card ---- */
  const before = page.applications.length;
  const toAdd = page.stackJobs("all").find((j) => !page.trackedUrls.has(j.key));
  page.pickJob(toAdd.key);
  await page.act("funnel");
  check("«В воронку» on a live card adds the row", page.applications.length === before + 1, `${before} -> ${page.applications.length}`);
  const added = page.applications.find((row) => row.url === toAdd.applyUrl);
  check("added straight as 'applied' — no bookmark stage", added?.status === "applied");
  // Boards append tracking parameters that come and go: the same job must not become a second row.
  const trackedUrl = new URL(toAdd.applyUrl);
  trackedUrl.searchParams.set("utm_source", "api");
  const variant = await (await post("/api/applications", { url: trackedUrl.href, title: toAdd.title, company: toAdd.company })).json();
  check("a tracking-parameter variant of an applied job is already tracked", variant.result === "already_tracked", variant.result);

  /* ---- hide one from the card ---- */
  const toHide = page.stackJobs("all").find((j) => !page.decided.has(j.key) && !page.trackedUrls.has(j.key));
  page.pickJob(toHide.key);
  clickIn(registry, "dock", { act: "hide" });
  clickIn(registry, "dock", { act: "reason", reason: "не тот стек" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  check("hiding from the card is persisted, with the reason",
    (await (await fetch(`${BASE}/api/dismissed`)).json()).dismissed.some((row) => row.url === toHide.applyUrl && row.reason === "не тот стек"));
  check("and moves on", page.currentKey !== toHide.key);
  const afterHide = await (await fetch(`${BASE}/api/search`)).json();
  check("a hidden job is gone from a fresh search", !afterHide.jobs.some((row) => row.applyUrl === toHide.applyUrl));
  check("hiding a job does not fetch the boards again", afterHide.freshness?.sources?.indeed?.lastSuccessAt === fetchedAt);

  // Hiding the top five makes an overlap with the next search effectively certain.
  const batch = (afterHide.jobs || []).slice(0, 5).map((row) => row.applyUrl);
  for (const jobUrl of batch) await post("/api/dismissed", { url: jobUrl });
  const afterBatch = await (await fetch(`${BASE}/api/search`)).json();
  check("the search reports what it hid", afterBatch.counts.hiddenForDismissed >= 1, `hid ${afterBatch.counts.hiddenForDismissed}`);
  check("none of the hidden batch is returned", !afterBatch.jobs.some((row) => batch.includes(row.applyUrl)));
  for (const jobUrl of batch) await post("/api/dismissed", { url: jobUrl }, "DELETE");
  const withHidden = await (await fetch(`${BASE}/api/search?includeDismissed=1`)).json();
  check("includeDismissed turns the filter off", withHidden.counts.hiddenForDismissed === 0);
  const shown = withHidden.jobs.find((row) => row.applyUrl === toHide.applyUrl);
  if (shown) check("a returned hidden job is marked dismissed", shown.dismissed === true);
  else console.log("SKIP  hidden job absent from the second live search — cannot check its flag");
  await post("/api/dismissed", { url: toHide.applyUrl }, "DELETE");
  check("restoring clears the dismissal", !(await (await fetch(`${BASE}/api/dismissed`)).json()).dismissed.some((row) => row.url === toHide.applyUrl));

  /* ---- the boards: narrowing is a search parameter ---- */
  registry.get("sourcefilter")._handlers.change({ target: { type: "checkbox", value: "himalayas", checked: false } });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const narrowedLive = page.searchResults.length === 0 || page.searchResults.every((j) => j.source === "indeed");
  check("unticking a board re-runs the search without it", narrowedLive);
  registry.get("sourcefilter")._handlers.change({ target: { type: "checkbox", value: "himalayas", checked: true } });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const narrowed = await (await fetch(`${BASE}/api/search?sources=himalayas`)).json();
  check("?sources narrows what is queried", (narrowed.reports || []).every((row) => row.source === "himalayas"));
  check("and the echoed profile says so", JSON.stringify(narrowed.profile.sources) === JSON.stringify(["himalayas"]));
  const forged = await (await fetch(`${BASE}/api/search?sources=glassdoor,zip_recruiter`)).json();
  check("an unknown board in the URL falls back to the profile, not to nothing", (forged.profile.sources || []).length === 2);

  /* ---- posting age: a search parameter, so each choice re-runs the search ---- */
  console.log("\n(re-running the search through the 24h option…)");
  const chipFor = (days) => chips.find((el) => el.value === String(days));
  check("the widest option — a month — is the default", chipFor(30).checked && chips.filter((el) => el.checked).length === 1);
  await chipFor(1).check();
  check("choosing one clears the rest", chipFor(1).checked && chips.filter((el) => el.checked).length === 1);
  const freshVisible = ["good", "maybe", "all", "skipped"].flatMap((s) => page.stackJobs(s));
  check("everything left under a 24h window is from today or yesterday",
    freshVisible.every((j) => (Date.now() - Date.parse(j.postedAt)) / 86_400_000 < 2), `${freshVisible.length} in the stacks`);
  check("and the filters button says a filter is on", registry.get("filterdot").hidden === false);
  await chipFor(30).check();
  check("«месяц» widens the window again", chipFor(30).checked && registry.get("filterdot").hidden === true);
  check("a month is the widest the UI can ask for",
    (await (await fetch(`${BASE}/api/search?hoursOld=99999`)).json()).profile.hoursOld === 720, "hoursOld is clamped to the profile window");

  console.log(`\n${failures === 0 ? "UI TESTS PASSED" : `${failures} UI TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("test harness crashed:", error);
  process.exit(1);
});
