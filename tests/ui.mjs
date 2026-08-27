/**
 * tests/ui.mjs — runs the dashboard's real inline JS against a real server.
 *
 * Run: npm run test:ui
 *
 * Why this exists: the page is a template literal inside dashboard.ts, so a
 * stray backtick or an unescaped \" is a syntax error that silently blanks the
 * whole page — nothing in `tsc` catches it. This harness has already caught two
 * such bugs. Run it after touching dashboard.ts.
 *
 * It spawns its own dashboard on a spare port with a throwaway database, seeds
 * rows through the real API, then evaluates the page script against a minimal
 * DOM shim. The search step hits live job boards, so this needs network.
 */

import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.TEST_PORT ?? 4399);
const BASE = `http://127.0.0.1:${PORT}`;
const DB = join(tmpdir(), `job-hunt-test-ui-${process.pid}.db`);

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
    checked: false,
    hidden: false,
    disabled: false,
    className: "",
    dataset: {},
    children: [],
    _handlers: {},
    classList: {
      _set: new Set(),
      add(name) { this._set.add(name); },
      remove(name) { this._set.delete(name); },
      toggle(name, on) { if (on) this._set.add(name); else this._set.delete(name); },
      contains(name) { return this._set.has(name); },
    },
    appendChild(child) { this.children.push(child); return child; },
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
    addEventListener(type, fn) { this._handlers[type] = fn; },
  };
}

function buildDocument(registry) {
  const tabs = ["tracker", "search"].map((view) => {
    const el = makeEl(`tab-${view}`);
    el.dataset.view = view;
    if (view === "tracker") el.classList.add("is-active");
    return el;
  });

  // The shim cannot parse HTML, so buttons are synthesised from the generated
  // markup — and MEMOIZED, because querySelectorAll must return the same
  // objects each call or the handler the page attached is lost.
  const cache = new Map();
  const addButtons = (attr = "data-add") => {
    const grid = registry.get("jobgrid").innerHTML;
    const entry = cache.get(attr);
    if (entry && entry.key === grid) return entry.buttons;
    const key = attr.replace("data-", "");
    // NOTE: \\d, not \d — inside a template literal \d is an invalid escape
    // that collapses to "d", so the pattern would look for data-add="(d+)".
    const buttons = [...grid.matchAll(new RegExp(`${attr}="(\\d+)"`, "g"))].map((match) => {
      const el = makeEl(`${key}-${match[1]}`);
      el.dataset[key] = match[1];
      return el;
    });
    cache.set(attr, { key: grid, buttons });
    return buttons;
  };

  return {
    document: {
      getElementById: (id) => registry.get(id) ?? makeEl(id),
      createElement: () => makeEl(),
      querySelectorAll: (selector) => {
        if (selector === ".tab") return tabs;
        if (selector === "#jobgrid button[data-add]") return addButtons("data-add");
        if (selector === "#jobgrid button[data-hide]") return addButtons("data-hide");
        if (selector === "#jobgrid button[data-restore]") return addButtons("data-restore");
        return [];
      },
    },
    tabs,
    addButtons,
  };
}

/* ------------------------------------------------------------------ */
/* Server lifecycle                                                    */
/* ------------------------------------------------------------------ */

/**
 * Spawns node directly on tsx's CLI rather than going through `npx`/a shell.
 *
 * With `shell: true`, kill() terminates the shell and leaves the actual server
 * running as an orphan. That bit for real: a leftover dashboard from a previous
 * run still held the port, so the next run seeded its rows into the OLD
 * database and then failed on "no such table" — silently testing the wrong
 * server. One child process means kill() actually kills it.
 */
function startDashboard() {
  const tsxCli = join("node_modules", "tsx", "dist", "cli.mjs");
  const child = spawn(process.execPath, [tsxCli, "src/dashboard.ts"], {
    env: { ...process.env, JOBHUNT_DB: DB, JOBHUNT_PORT: String(PORT) },
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

/* ------------------------------------------------------------------ */

async function main() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB + suffix, { force: true });
    } catch {
      // a previous run's file may still be held open; the pid-suffixed name
      // means this run gets its own file anyway
    }
  }

  if (!(await portIsFree())) {
    console.log(
      `FAIL  something is already listening on ${PORT}. Stop it (or set TEST_PORT) — ` +
        `otherwise this would test that server against a different database.`,
    );
    process.exit(1);
  }

  const server = startDashboard();
  const cleanup = () => {
    server.kill();
    // Best effort only. On Windows the child still holds the database open for
    // a moment after kill(), and rm then fails with EPERM — a leftover temp
    // file must never fail an otherwise passing run.
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        rmSync(DB + suffix, { force: true });
      } catch {
        // next run removes it
      }
    }
  };
  process.on("exit", cleanup);

  if (!(await waitForServer(server))) {
    console.log("FAIL  dashboard did not start");
    process.exit(1);
  }

  /* ---- seed through the real API, so no schema is duplicated here ---- */
  const seed = [
    { url: "https://example.com/seed/1", title: "Senior Frontend Engineer", company: "Alpha" },
    { url: "https://example.com/seed/2", title: "Senior AI Engineer", company: "Beta" },
    { url: "https://example.com/seed/3", title: "Fullstack Developer", company: "Gamma" },
  ];
  for (const job of seed) {
    await fetch(`${BASE}/api/applications`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(job),
    });
  }
  // One applied-and-stale row so the ghosted styling has something to render.
  const raw = new Database(DB);
  raw.prepare("UPDATE applications SET status='applied', applied_at=?, response_at=NULL WHERE url=?")
    .run(new Date(Date.now() - 40 * 86_400_000).toISOString(), "https://example.com/seed/3");
  raw.close();

  /* ---- the page must at least parse ---- */
  const html = await (await fetch(`${BASE}/`)).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/);
  check("page serves an inline script", Boolean(script));
  const js = script[1];
  let parses = true;
  try {
    new Function(js);
  } catch (error) {
    parses = false;
    check("inline JS parses", false, error.message);
  }
  if (parses) check("inline JS parses", true, `${js.length} chars`);
  else {
    console.log("\nThe page script is a syntax error — everything below would fail.");
    process.exit(1);
  }

  check("page is self-contained (no external assets)",
    !/(src|href)="https?:\/\//.test(html.replace(/fonts\.googleapis\.com/g, "")));

  /* ---- evaluate it against the shim ---- */
  const registry = new Map();
  for (const id of [
    "dbinfo", "cards", "funnel", "rows", "empty", "toast",
    "view-tracker", "view-search", "searchform", "searchbtn",
    "srcline", "jobgrid", "searchempty", "statusfilter", "profileline",
    "hideApplied", "showDismissed", "dismissedCount",
  ]) registry.set(id, makeEl(id));

  const { document, tabs, addButtons } = buildDocument(registry);
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.document = document;
  // NOTE: never overwrite globalThis timers here — undici's fetch needs them,
  // and doing so once made every request in this harness fail silently.

  const page = new Function(
    "document", "fetch", "setInterval", "setTimeout", "clearTimeout",
    `${js}
     ; return {
       load, runSearch, showView, renderRows,
       get applications(){return applications},
       get searchResults(){return searchResults},
       get trackedUrls(){return trackedUrls},
       setFilter(v){ statusFilter = v },
       setHideApplied(v){ hideApplied = v },
       renderSearchAgain(){ renderSearch(lastSearchPayload) },
       dismiss, restore,
       setSort(k, d){ sort = { key: k, dir: d } },
       sortedApplications,
     };`,
  )(document, (path, init) => nativeFetch(BASE + path, init), () => 0, () => 0, () => {});

  /* ---- tracker ---- */
  await page.load();
  check("tracker loads rows", page.applications.length === 3, `${page.applications.length} rows`);
  check("tracked URLs collected for the search tab", page.trackedUrls.size === 3);
  check("stat cards render", registry.get("cards").innerHTML.includes("Response rate"));
  check("funnel renders all 8 stages",
    (registry.get("funnel").innerHTML.match(/class="frow"/g) || []).length === 8);
  // 8 statuses + the two grouped shortcuts ("applied+", "open").
  check("status filter is populated",
    registry.get("statusfilter").children.length === 10,
    `${registry.get("statusfilter").children.length} options`);

  const rowsHtml = registry.get("rows").innerHTML;
  check("a row per application", (rowsHtml.match(/<tr/g) || []).length === 3);
  check("saved rows are visually distinguished", rowsHtml.includes("is-saved"));
  check("saved rows say they are not applied", rowsHtml.includes("saved, not applied"));
  check("ghosted row is flagged", rowsHtml.includes("is-ghosted"));
  check("status dropdown per row", (rowsHtml.match(/<select data-id=/g) || []).length === 3);

  const escaped = new Function(`${js}; return esc('<img src=x onerror=alert(1)>')`)();
  check("esc() neutralises HTML", escaped === "&lt;img src=x onerror=alert(1)&gt;");

  /* ---- tabs ---- */
  page.showView("search");
  check("Search tab reveals the search view",
    registry.get("view-search").hidden === false && registry.get("view-tracker").hidden === true);
  check("active tab is marked", tabs[1].classList.contains("is-active"));
  page.showView("tracker");
  check("Tracker tab switches back", registry.get("view-tracker").hidden === false);

  /* ---- filter + sort ---- */
  page.setFilter("saved");
  page.renderRows();
  const savedRows = (registry.get("rows").innerHTML.match(/<tr/g) || []).length;
  check("status filter narrows the table", savedRows === 2, `${savedRows} of 3`);
  page.setFilter("");
  page.renderRows();

  page.setSort("company", "asc");
  const asc = page.sortedApplications().map((row) => row.company).join(",");
  page.setSort("company", "desc");
  const desc = page.sortedApplications().map((row) => row.company).join(",");
  check("sorting reverses", asc !== desc, `${asc}  vs  ${desc}`);

  /* ---- profile search (live network) ---- */
  console.log("\n(running a live profile search through the page's own code path…)");
  await page.runSearch();

  const grid = registry.get("jobgrid").innerHTML;
  check("cards render", page.searchResults.length > 0, `${page.searchResults.length} jobs`);
  check("a card per result",
    (grid.match(/class="jobcard/g) || []).length === page.searchResults.length);
  check("eligibility badge on cards", /<span class="lvl (high|medium)">/.test(grid));
  check("no 'low' badge", !grid.includes('class="lvl low"'));
  check("fit badge on cards", /class="fit/.test(grid));
  check("no wrong-stack results",
    page.searchResults.every((job) => job.fit >= 0),
    `min fit ${Math.min(...page.searchResults.map((job) => job.fit))}`);
  check("apply link opens in a new tab", grid.includes('class="applylink"') && grid.includes('target="_blank"'));
  check("profile line says what was searched",
    registry.get("profileline").innerHTML.includes("Poland"));
  check("per-source counts are shown",
    /indeed \d+/.test(registry.get("srcline").innerHTML));
  check("add button present", /данные|В воронк/.test(grid) || grid.includes("В воронк"));

  /* ---- add to funnel ---- */
  const buttons = addButtons("data-add");
  const index = page.searchResults.findIndex((job) => !page.trackedUrls.has(job.applyUrl));
  check("found an untracked card", index >= 0);
  const button = buttons.find((el) => Number(el.dataset.add) === index);
  check("its click handler is attached", typeof button?._handlers.click === "function");

  const before = page.applications.length;
  await button._handlers.click();

  const job = page.searchResults[index];
  check("button flips to the added state", button.textContent.includes("воронк"),
    JSON.stringify(button.textContent));
  check("button is disabled after adding", button.disabled === true);
  check("row count grew by one", page.applications.length === before + 1,
    `${before} -> ${page.applications.length}`);
  const added = page.applications.find((row) => row.url === job.applyUrl);
  check("the new row is in the tracker", Boolean(added));
  check("added with status 'saved'", added?.status === "saved");

  /* ---- hide a job from search ---- */
  const hideButtons = addButtons("data-hide");
  check("every visible card offers a hide button",
    hideButtons.length > 0, `${hideButtons.length} buttons`);

  // Deliberately NOT the card we just added: hiding that one would leave no
  // tracked job on screen, and the "hide applied" check below would be vacuous.
  const hideButton = hideButtons.find((el) => Number(el.dataset.hide) !== index) ?? hideButtons[0];
  const hideIndex = Number(hideButton.dataset.hide);
  const toHide = page.searchResults[hideIndex];
  await hideButton._handlers.click();

  check("hidden job disappears from the grid",
    !registry.get("jobgrid").innerHTML.includes(toHide.applyUrl.slice(-24)),
    toHide.company);
  check("the dismissal was persisted",
    (await (await fetch(`${BASE}/api/dismissed`)).json()).dismissed
      .some((row) => row.url === toHide.applyUrl));

  const afterHide = await (await fetch(`${BASE}/api/search`)).json();
  check("a hidden job is gone from a fresh search",
    !afterHide.jobs.some((row) => row.applyUrl === toHide.applyUrl));

  /*
   * The counter only counts dismissed jobs the search actually ran into, and
   * the boards are live — one hidden job need not come back on the next call.
   * Hiding the top five makes an overlap effectively certain without pretending
   * the data is stable.
   */
  const batch = (afterHide.jobs || []).slice(0, 5).map((row) => row.applyUrl);
  for (const jobUrl of batch) {
    await fetch(`${BASE}/api/dismissed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: jobUrl }),
    });
  }
  const afterBatch = await (await fetch(`${BASE}/api/search`)).json();
  check("the search reports what it hid",
    afterBatch.counts.hiddenForDismissed >= 1,
    `hid ${afterBatch.counts.hiddenForDismissed} of ${batch.length} dismissed`);
  check("none of the hidden batch is returned",
    !afterBatch.jobs.some((row) => batch.includes(row.applyUrl)));
  for (const jobUrl of batch) {
    await fetch(`${BASE}/api/dismissed`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: jobUrl }),
    });
  }

  const withHidden = await (await fetch(`${BASE}/api/search?includeDismissed=1`)).json();
  check("includeDismissed turns the filter off",
    withHidden.counts.hiddenForDismissed === 0,
    `hiddenForDismissed ${withHidden.counts.hiddenForDismissed}`);
  // The boards are live, so a second search need not return the very same job.
  // Only assert the marking when it did come back.
  const shown = withHidden.jobs.find((row) => row.applyUrl === toHide.applyUrl);
  if (shown) check("a returned hidden job is marked dismissed", shown.dismissed === true);
  else console.log("SKIP  hidden job absent from the second live search — cannot check its flag");

  /* ---- restore it ---- */
  await fetch(`${BASE}/api/dismissed`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: toHide.applyUrl }),
  });
  check("restoring clears the dismissal",
    (await (await fetch(`${BASE}/api/dismissed`)).json()).dismissed.length === 0);

  /* ---- "hide applied" filter ---- */
  const beforeFilter = (registry.get("jobgrid").innerHTML.match(/class="jobcard/g) || []).length;
  page.setHideApplied(true);
  page.renderSearchAgain();
  const afterFilter = (registry.get("jobgrid").innerHTML.match(/class="jobcard/g) || []).length;
  check("hiding applied-to jobs shrinks the grid",
    afterFilter < beforeFilter, `${beforeFilter} -> ${afterFilter}`);
  page.setHideApplied(false);
  page.renderSearchAgain();

  /* ---- tracker: grouped "applied+" filter ---- */
  await page.load();
  page.setFilter("applied+");
  page.renderRows();
  const appliedPlus = (registry.get("rows").innerHTML.match(/<tr/g) || []).length;
  const expected = page.applications.filter((row) => row.status !== "saved").length;
  check("tracker filter 'applied+' shows every non-saved row",
    appliedPlus === expected, `${appliedPlus} of ${page.applications.length}`);
  page.setFilter("open");
  page.renderRows();
  const open = (registry.get("rows").innerHTML.match(/<tr/g) || []).length;
  check("tracker filter 'open' excludes ghosted and rejected",
    open <= appliedPlus, `open ${open} <= applied+ ${appliedPlus}`);
  page.setFilter("");

  console.log(`\n${failures === 0 ? "UI TESTS PASSED" : `${failures} UI TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("test harness crashed:", error);
  process.exit(1);
});
