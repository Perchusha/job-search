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

  // The date radios are static markup, not generated, so the shim cannot derive
  // them from innerHTML. Built once and returned by identity every call.
  // Radio semantics are the browser's job, so the shim mimics them: checking
  // one clears the rest of the group.
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

  // Source pills are generated, so derive them from the rendered markup the way
  // the job-card buttons are — memoized, or the attached handler is lost.
  let boxCache = { key: null, boxes: [] };
  const sourceBoxes = () => {
    const html = registry.get("sourcefilter").innerHTML;
    if (boxCache.key === html) return boxCache.boxes;
    const boxes = [...html.matchAll(/<input type="checkbox" value="([a-z_]+)"( checked)?>/g)].map(
      (match) => {
        const el = makeEl(`src-${match[1]}`);
        el.value = match[1];
        el.checked = Boolean(match[2]);
        el.toggle = () => {
          el.checked = !el.checked;
          return el._handlers.change?.();
        };
        return el;
      },
    );
    boxCache = { key: html, boxes };
    return boxes;
  };

  return {
    document: {
      getElementById: (id) => registry.get(id) ?? makeEl(id),
      createElement: () => makeEl(),
      querySelectorAll: (selector) => {
        if (selector === ".tab") return tabs;
        if (selector === "#datefilter input[type=radio]") return chips;
        if (selector === "#sourcefilter input[type=checkbox]") return sourceBoxes();
        if (selector === "#jobgrid button[data-add]") return addButtons("data-add");
        if (selector === "#jobgrid button[data-hide]") return addButtons("data-hide");
        if (selector === "#jobgrid button[data-restore]") return addButtons("data-restore");
        return [];
      },
    },
    tabs,
    chips,
    sourceBoxes,
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
    // LinkedIn is in the profile by default and is most of a search's wall
    // clock; this suite runs several live searches, so it opts out. The filter
    // logic under test is the same whichever boards are configured.
    env: {
      ...process.env,
      JOBHUNT_DB: DB,
      JOBHUNT_PORT: String(PORT),
      JOBHUNT_SOURCES: "indeed,himalayas",
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
  // One stale row so the ghosted styling has something to render. The other two
  // stay plain 'applied' — the funnel has no pre-application stage any more.
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

  check("nothing is loaded from off this machine",
    !/(src|href)="https?:\/\//.test(html.replace(/fonts\.googleapis\.com/g, "")));
  check("the requested font stack is global",
    html.includes('"Space Grotesk", "Plus Jakarta Sans", "Segoe UI", sans-serif'));
  check("Pico is linked", html.includes('href="/pico.css"'));
  const pico = await fetch(`${BASE}/pico.css`);
  check("and served from node_modules",
    pico.ok && pico.headers.get("content-type").startsWith("text/css"));
  check("the served stylesheet is the conditional build",
    (await pico.text()).includes(".pico "));

  /* ---- evaluate it against the shim ---- */
  const registry = new Map();
  for (const id of [
    "dbinfo", "cards", "funnel", "rows", "empty", "toast",
    "view-tracker", "view-search", "searchform", "searchbtn",
    "srcline", "jobgrid", "searchempty", "statusfilter", "profileline",
    "hideApplied", "showDismissed", "dismissedCount", "datefilter", "sourcefilter",
    "loadmore",
  ]) registry.set(id, makeEl(id));

  const { document, tabs, chips, sourceBoxes, addButtons } = buildDocument(registry);
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.document = document;
  // NOTE: never overwrite globalThis timers here — undici's fetch needs them,
  // and doing so once made every request in this harness fail silently.

  const page = new Function(
    "document", "fetch", "setInterval", "setTimeout", "clearTimeout",
    `${js}
     ; return {
       load, runSearch, showView, renderRows, esc,
       get applications(){return applications},
       get searchResults(){return searchResults},
       get trackedUrls(){return trackedUrls},
       get visibleCount(){return visibleCount},
       get renderLimit(){return renderLimit},
       showMore,
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
  check("stat cards render", registry.get("cards").innerHTML.includes("Responded"));
  check("the response rate sits on the Responded card, not in one of its own",
    !registry.get("cards").innerHTML.includes("Response rate"));
  check("funnel renders all 8 stages",
    (registry.get("funnel").innerHTML.match(/class="frow"/g) || []).length === 8);
  // 8 statuses + the grouped "open" shortcut. 'saved' is gone; so is 'applied+',
  // which only ever meant "not saved".
  check("status filter is populated",
    registry.get("statusfilter").children.length === 9,
    `${registry.get("statusfilter").children.length} options`);

  const rowsHtml = registry.get("rows").innerHTML;
  check("a row per application", (rowsHtml.match(/<tr/g) || []).length === 3);
  check("ghosted row is flagged", rowsHtml.includes("is-ghosted"));
  check("status dropdown per row",
    (rowsHtml.match(/<select class="status"/g) || []).length === 3);
  check("status is shown once, not as a badge AND a dropdown",
    !rowsHtml.includes('class="badge'));
  check("the dropdown carries its status for colouring", rowsHtml.includes('data-s="applied"'));
  check("no notes column", !rowsHtml.includes('class="notes"'));

  /*
   * Take esc() off the page object rather than evaluating the script a second
   * time. A second instance re-runs bindChrome() against the same shim
   * elements, and addEventListener keeps only the last handler per event — so
   * every control silently ended up wired to a throwaway copy of the page whose
   * searchLoaded was false and whose payload was empty. The date chips were the
   * first control to actually depend on being wired to the live instance.
   */
  check("esc() neutralises HTML",
    page.esc("<img src=x onerror=alert(1)>") === "&lt;img src=x onerror=alert(1)&gt;");

  /* ---- tabs ---- */
  page.showView("search");
  check("Search tab reveals the search view",
    registry.get("view-search").hidden === false && registry.get("view-tracker").hidden === true);
  check("active tab is marked", tabs[1].classList.contains("is-active"));
  page.showView("tracker");
  check("Tracker tab switches back", registry.get("view-tracker").hidden === false);

  /* ---- filter + sort ---- */
  page.setFilter("applied");
  page.renderRows();
  const appliedRows = (registry.get("rows").innerHTML.match(/<tr/g) || []).length;
  check("status filter narrows the table", appliedRows === 2, `${appliedRows} of 3`);
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

  const cachedSearch = await (
    await fetch(`${BASE}/api/search?sources=indeed,himalayas&hoursOld=720`)
  ).json();
  check("an identical search is served from the server cache", cachedSearch.cache?.hit === true);
  check("the search cache defaults to one hour", cachedSearch.cache?.ttlSeconds === 3600);

  const grid = registry.get("jobgrid").innerHTML;
  check("cards render", page.searchResults.length > 0, `${page.searchResults.length} jobs`);
  const cardCount = () => (registry.get("jobgrid").innerHTML.match(/class="jobcard/g) || []).length;
  check("only the first batch is drawn, not the whole result set",
    cardCount() === Math.min(page.renderLimit, page.visibleCount)
      && page.visibleCount > cardCount(),
    `${cardCount()} of ${page.visibleCount} visible, ${page.searchResults.length} returned`);
  check("the sentinel says how much is left",
    registry.get("loadmore").hidden === false
      && registry.get("loadmore").innerHTML.includes("из " + page.visibleCount));

  check("eligibility badge on cards", /<span class="lvl (high|medium)">/.test(grid));
  check("no 'low' badge", !grid.includes('class="lvl low"'));
  check("fit badge on cards", /class="fit/.test(grid));
  check("no wrong-stack results",
    page.searchResults.every((job) => job.fit >= 0),
    `min fit ${Math.min(...page.searchResults.map((job) => job.fit))}`);
  // Against what is drawn, not against the whole result set: the grid renders
  // one batch at a time now.
  check("the whole card opens the posting in a new tab",
    (grid.match(/class="cardlink"/g) || []).length
      === (grid.match(/class="jobcard/g) || []).length
      && grid.includes('target="_blank"'));
  check("the title is no longer the posting link", !grid.includes("<h3><a"));
  check("the redundant open-posting action is gone", !/open posting/i.test(grid));
  check("profile line says what was searched",
    registry.get("profileline").innerHTML.includes("Poland"));
  // Per-source counts moved onto the pills; this line carries the pipeline.
  check("the counts line still says what the pipeline dropped",
    /\d+ fetched/.test(registry.get("srcline").innerHTML)
      && /eligible/.test(registry.get("srcline").innerHTML),
    registry.get("srcline").innerHTML.replace(/<[^>]+>/g, "").slice(0, 90));
  check("add button present", grid.includes("В воронку"));
  check("hide is a grey secondary button",
    grid.includes('class="btn secondary" data-hide='));
  check("cards say how old the posting is", grid.includes('class="when"'));

  /* ---- lazy loading ----
   * Kept below every check that reads the `grid` snapshot above: draining the
   * list re-renders, and a stale snapshot compared against a live count is
   * exactly the trap this block would otherwise set. */
  const firstBatch = cardCount();
  page.showMore();
  check("reaching the bottom draws more", cardCount() > firstBatch,
    `${firstBatch} -> ${cardCount()}`);
  check("and it never overshoots what is visible", cardCount() <= page.visibleCount);
  while (page.renderLimit < page.visibleCount) page.showMore();
  check("draining the list hides the sentinel",
    cardCount() === page.visibleCount && registry.get("loadmore").hidden === true,
    `${cardCount()} of ${page.visibleCount}`);
  check("showMore past the end is a no-op", (page.showMore(), cardCount()) === page.visibleCount);

  /* ---- add to funnel ---- */
  const buttons = addButtons("data-add");
  const index = page.searchResults.findIndex((job) => !page.trackedUrls.has(job.applyUrl));
  check("found an untracked card", index >= 0);
  const button = buttons.find((el) => Number(el.dataset.add) === index);
  check("its click handler is attached", typeof button?._handlers.click === "function");

  const before = page.applications.length;
  await button._handlers.click();

  const job = page.searchResults[index];
  check("the card re-renders into the added state",
    registry.get("jobgrid").innerHTML.includes("✓ Откликнулся"));
  check("row count grew by one", page.applications.length === before + 1,
    `${before} -> ${page.applications.length}`);
  const added = page.applications.find((row) => row.url === job.applyUrl);
  check("the new row is in the tracker", Boolean(added));
  check("added straight as 'applied' — no bookmark stage", added?.status === "applied");

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
  // Counted on what the filter matched, not on what is drawn: with the render
  // cap in play both numbers could be one batch and the check would be blind.
  const beforeFilter = page.visibleCount;
  page.setHideApplied(true);
  page.renderSearchAgain();
  check("hiding applied-to jobs shrinks the list",
    page.visibleCount < beforeFilter, `${beforeFilter} -> ${page.visibleCount}`);

  // With that filter on, pressing "В воронку" has to make the card disappear
  // then and there — not on the next refresh.
  const liveButtons = addButtons("data-add");
  const untracked = liveButtons
    .map((el) => Number(el.dataset.add))
    .find((i) => !page.trackedUrls.has(page.searchResults[i].applyUrl));
  if (untracked === undefined) {
    console.log("SKIP  every visible card is already tracked — nothing left to add");
  } else {
    const target = page.searchResults[untracked];
    await liveButtons.find((el) => Number(el.dataset.add) === untracked)._handlers.click();
    check("adding while 'скрыть те, что в воронке' is on removes the card at once",
      !registry.get("jobgrid").innerHTML.includes(target.applyUrl.slice(-24)),
      target.company);
  }

  page.setHideApplied(false);
  page.renderSearchAgain();

  /* ---- source filter ---- */
  const boxes = sourceBoxes();
  // Two here because of JOBHUNT_SOURCES above; the real profile ships three.
  check("a pill per configured board", boxes.length === 2,
    boxes.map((el) => el.value).join(", "));
  check("every board starts switched on", boxes.every((el) => el.checked));
  check("each pill carries its fetch count",
    /<span class="n">\d+<\/span>/.test(registry.get("sourcefilter").innerHTML),
    registry.get("sourcefilter").innerHTML.replace(/<[^>]+>/g, " ").trim());

  // Narrowing is a search parameter, so the server must honour it.
  const narrowed = await (await fetch(`${BASE}/api/search?sources=himalayas`)).json();
  check("?sources narrows what is queried",
    (narrowed.reports || []).every((row) => row.source === "himalayas"),
    (narrowed.reports || []).map((row) => row.source).join(", "));
  check("and the echoed profile says so",
    JSON.stringify(narrowed.profile.sources) === JSON.stringify(["himalayas"]));

  // It must never be able to widen it, whatever the URL says.
  const forged = await (await fetch(`${BASE}/api/search?sources=glassdoor,zip_recruiter`)).json();
  check("an unknown board in the URL falls back to the profile, not to nothing",
    (forged.profile.sources || []).length === 2,
    JSON.stringify(forged.profile.sources));

  /* ---- posting-age radios (a search parameter, so each one re-runs the search) ---- */
  console.log("\n(re-running the search through the 24h option…)");
  const chipFor = (days) => chips.find((el) => el.value === String(days));
  const wideCount = page.searchResults.length;
  check("the widest option — a month — is the default",
    chipFor(30).checked && chips.filter((el) => el.checked).length === 1);

  await chipFor(1).check();
  check("choosing one clears the rest",
    chipFor(1).checked && chips.filter((el) => el.checked).length === 1);
  /*
   * Assert on the rendered grid, not on searchResults. hoursOld only reaches
   * the scraped boards — Himalayas ignores it and happily returns month-old
   * rows — so what the window really guarantees is what survives the
   * client-side pass. Under 24h that leaves only "сегодня" and "вчера".
   */
  const fresh = page.searchResults;
  const freshGrid = registry.get("jobgrid").innerHTML;
  check("every card left standing under a 24h window is from today or yesterday",
    !/\d+ дн\. назад/.test(freshGrid) && !freshGrid.includes(">без даты<"),
    `${fresh.length} returned, ${(freshGrid.match(/class="jobcard/g) || []).length} shown`);
  check("the profile line reports the narrowed window",
    registry.get("profileline").innerHTML.includes("last 1d"),
    registry.get("profileline").innerHTML.slice(-40));

  await chipFor(30).check();
  check("«месяц» widens the window again",
    page.searchResults.length >= fresh.length,
    `${fresh.length} (24h) -> ${page.searchResults.length} (month), was ${wideCount}`);
  check("a month is the widest the UI can ask for",
    (await (await fetch(`${BASE}/api/search?hoursOld=99999`)).json()).profile.hoursOld === 720,
    "hoursOld is clamped to the profile window");

  /* ---- tracker: grouped "open" filter ---- */
  await page.load();
  page.setFilter("open");
  page.renderRows();
  const open = (registry.get("rows").innerHTML.match(/<tr/g) || []).length;
  const alive = page.applications.filter((row) =>
    ["applied", "responded", "screening", "interview"].includes(row.status)).length;
  check("tracker filter 'open' is exactly the still-alive rows",
    open === alive, `${open} of ${page.applications.length}`);
  check("'open' excludes the ghosted row", open < page.applications.length);
  page.setFilter("");

  console.log(`\n${failures === 0 ? "UI TESTS PASSED" : `${failures} UI TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("test harness crashed:", error);
  process.exit(1);
});
