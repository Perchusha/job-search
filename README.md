# job-hunt

A personal, local-only MCP server + web dashboard for finding remote jobs you can
actually apply to **from Poland (EU)**, and tracking what happened to each application.

No cloud, no accounts, no API keys, no paid services. One SQLite file on your disk.
(The one exception is optional: Claude's verdict on a card runs on the Claude Code already
logged in on this machine — see [Claude's verdict on a card](#claudes-verdict-on-a-card).)

The flow is **search → see eligible jobs → drop them into the funnel**, from either the
assistant or the browser.

- **MCP server** — 8 tools your AI assistant can call (`find_jobs`, `log_found_jobs`,
  `dismiss_job`, `log_application`, `update_status`, `add_note`, `list_applications`,
  `get_stats`).
- **Dashboard** — two tabs at <http://localhost:4321>: **Search** (one Refresh button, no
  query to type) and **Tracker** (funnel + sortable application table).
- **Two separate scores** — cards use `high` / `medium` for professional profile match,
  while `geo confirmed` / `geo check` says whether a Poland-based candidate can apply.

**There is no search box.** What to look for lives in [src/profile.ts](src/profile.ts) —
target searches, location, remote preference, and the stack weights that decide relevance.
The stack does not change between runs, so the dashboard is a single **Refresh** button and
`find_jobs` needs no arguments. Edit that one file to change what gets found.

Search runs through **one** implementation, [src/pipeline.ts](src/pipeline.ts)'s
`searchJobs()`, called by both the `find_jobs` tool and `GET /api/search`. The browser never
talks to a job feed directly — the server does it, so there is no CORS problem and both
paths share the same rate-limit handling.

Both processes read and write the same SQLite file; WAL mode makes that safe.

---

## Prerequisites

- **Node.js 20+** (developed and tested on Node 24).
- Build tools for the `better-sqlite3` native module. A prebuilt binary is downloaded
  for most platforms, so usually you need nothing. If the install falls back to
  compiling from source:
  - **Windows** — `npm install --global windows-build-tools`, or install
    "Desktop development with C++" from the Visual Studio Installer.
  - **macOS** — `xcode-select --install`.
  - **Linux** — `sudo apt install build-essential python3`.

> **npm 11+ note:** newer npm blocks package install scripts by default and prints an
> `allow-scripts` warning. If `better-sqlite3` fails to load afterwards, run
> `npm approve-scripts` (or `npm rebuild better-sqlite3`) and reinstall.

## Install

```bash
npm install
```

Optional but recommended — the JobSpy scraper (Indeed/LinkedIn), which is where most of the
volume comes from. It needs **Python 3.10+** and installs into a project-local `.venv`, so
your global Python stays untouched:

```bash
npm run setup:jobspy        # Windows
npm run setup:jobspy:unix   # macOS / Linux
```

Skip it and everything still works — the free feeds carry the search and JobSpy sources
report themselves as skipped. `JOBHUNT_PYTHON` overrides the interpreter.

Verify the eligibility scorer works:

```bash
npm run sanity     # 20/20 checks passed.
```

## Run

```bash
npm run dashboard  # http://localhost:4321
npm run refresh    # fetch every board that is due into the postings table (add -- --force for the fast boards now)
npm run mcp        # stdio MCP server (your AI client normally starts this for you)
npm test           # typecheck + scorer checks + MCP + dashboard UI
```

`npm run mcp` speaks the MCP protocol on stdin/stdout, so running it by hand just looks
like it hangs — that's correct. Point a client at it instead.

There is no build step; `tsx` runs the TypeScript directly.

### Environment

| Variable                       | Default              | Purpose                                |
| ------------------------------ | -------------------- | -------------------------------------- |
| `JOBHUNT_DB`                   | `~/.job-hunt/jobs.db` | SQLite file (dir auto-created)         |
| `JOBHUNT_PORT`                 | `4321`               | Dashboard port                         |
| `JOBHUNT_HOST`                 | `127.0.0.1`          | Bind address; use `0.0.0.0` for LAN   |
| `JOBHUNT_REFRESH_HOURS`        | `6`                  | How often the fast boards are re-fetched in the background (LinkedIn: daily) |
| `JOBHUNT_BACKGROUND`           | on                   | `0` turns off the dashboard's background refresh; searches then fill the table on demand |
| `JOBHUNT_CLAUDE_AUTO`          | on                   | `0` stops Claude judging the Search tab's cards in the background; the card button still works |
| `JOBHUNT_CLAUDE_MODEL`         | `sonnet`             | Model for the verdicts (`opus` reads closer, counts heavier against the plan) |
| `JOBHUNT_CLAUDE_EFFORT`        | `low`                | Effort for the verdicts (`low`…`max`); the user settings' `xhigh` is for coding sessions |
| `JOBHUNT_CLAUDE_DAILY`         | `80`                 | Most verdicts the background queue makes in a day; manual ones are not counted |
| `JOBHUNT_CLAUDE`               | `claude` on PATH     | Path to the Claude Code executable (a `.mjs` runs under Node — the tests' stand-in) |

### Desktop app (tray, autostart, notifications)

[`desktop/`](desktop/) is an Electron shell around the same server, so the background
refresh keeps running without a terminal window:

- starts with Windows straight into the tray (optional) and runs the dashboard server as a
  hidden child process — or uses one already running, e.g. from `Job Hunt.bat` — restarting it
  if it dies;
- the dashboard opens in its own window; closing it keeps the app in the tray, **Выйти** stops
  the app and the server;
- notifications: "N новых вакансий" when a refresh finds postings (from `/api/new-count?since=`,
  counted the way the Search tab shows them — not hidden, not applied, not a rule hit), and a
  daily digest "За сутки появилось N новых вакансий"; quiet hours; clicking one opens Search.
  The tray icon gets a dot and the count while there is something new;
- **Настройки…**: autostart, refresh interval, LinkedIn in the background, notification
  threshold, quiet hours, digest time, port, Wi-Fi access. Stored in
  `%APPDATA%\Job Hunt\settings.json`; the log is `job-hunt.log` next to it.

```bash
cd desktop
npm install          # Electron and electron-builder, kept out of the main package
npm start            # run from the checkout
npm run build        # dist/Job Hunt Setup 1.0.0.exe — per-user installer, no admin rights
```

The installed app does not carry a copy of the project: it starts `src/dashboard.ts` from this
repo (the path is baked in by `build.mjs`; `JOBHUNT_REPO` overrides it) with the `node` on
PATH, so moving the repo means rebuilding. The installer is unsigned, so SmartScreen asks once.
Windows' own notification switch must be on (Settings → System → Notifications); the settings
window says when it is off and opens that page.

### Windows app (terminal)

Double-click **`Job Hunt.bat`**. It starts the dashboard, opens it in the
default browser and prints an address that can be opened from another device
on the same Wi-Fi. Close the black launcher window to stop the app. On the
first launch Windows may ask whether Node.js can access private networks;
allow **Private networks** if Wi-Fi access is wanted.

There is deliberately no login screen. Anyone connected to the same network
can therefore open the dashboard while the app is running, so use this mode
only on a trusted home Wi-Fi.

## Connect an MCP client

### Claude Desktop

Edit `claude_desktop_config.json`
(Windows: `%APPDATA%\Claude\claude_desktop_config.json`,
macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`),
then restart Claude Desktop:

```json
{
  "mcpServers": {
    "job-hunt": {
      "command": "npx",
      "args": ["tsx", "/ABSOLUTE/PATH/job-search/src/index.ts"],
      "env": { "JOBHUNT_DB": "/ABSOLUTE/PATH/.job-hunt/jobs.db" }
    }
  }
}
```

Use absolute paths — the client does not run from this directory. On Windows, write them
with escaped backslashes (`"D:\\Projects\\job-search\\src\\index.ts"`) or
forward slashes.

### Claude Code

```bash
claude mcp add job-hunt -- npx tsx /ABSOLUTE/PATH/job-search/src/index.ts
```

### Cursor

Add the same `mcpServers` block to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project).

## Example prompts

- **"Find me jobs"** — no arguments needed; `find_jobs` searches the saved profile
- "Hide that Angular one, I'm not interested" — `dismiss_job`; it never appears again
- "What have I hidden?" / "Actually bring back the Callstack one"
- "Find fullstack typescript jobs, worldwide only, at least 120k" — a one-off override
- **"Add all of those to my funnel"** — one `log_found_jobs` call, no field re-entry
- "Log that I applied to Vercel — Senior Fullstack Engineer, `<url>`"
- "Mark application 4 as interview"
- "Add a note to 4: recruiter call went well, next step is a take-home"
- "Show my funnel"
- "Which applications have ghosted me?"

The search → funnel flow in one exchange:

> **You:** find senior typescript jobs I can apply to from Poland
> **Assistant:** *(calls `find_jobs`)* — 7 eligible, mostly `high`…
> **You:** add the first four to my funnel
> **Assistant:** *(calls `log_found_jobs`)* — 4 added as `applied`, 0 already tracked.

Re-running the same add reports `already_tracked` and creates no duplicates, so it is safe
to say "add them" twice.

## How eligibility scoring works

Residence is assumed to be **Poland, on a residence permit rather than EU citizenship** —
so a role onsite in another EU country still scores `low`: it would need relocation and a new
permit, which "EU-eligible" wording elsewhere would wrongly imply is fine.

 These tokens are treated as EU/worldwide-friendly:
`worldwide`, `anywhere`, `europe`, `eu`, `european union`, `emea`, `poland`, `pl` — matched
on **word boundaries**, so "Deutschland" does not match `eu` and "Naples" does not match `pl`.

| Source        | `high`                                          | `medium`                                | `low`                                |
| ------------- | ----------------------------------------------- | --------------------------------------- | ------------------------------------ |
| **Himalayas** | no `locationRestrictions`, or a friendly token   | —                                       | lists only non-EU countries          |
| **RemoteOK**  | `location` has a friendly token                 | empty or unrecognized location          | US/Canada/Americas only              |
| **Arbeitnow** | `remote === true` (EU, same timezone as Poland)  | onsite inside Poland                     | onsite outside Poland                |
| **Indeed / LinkedIn / other scraped** | remote **and** a Poland/EU location | remote elsewhere (may require local tax residency), onsite in Poland, or no location stated | onsite outside Poland |

`find_jobs` drops eligibility `low` by default (`onlyEligible=true`). Eligibility `medium`
is kept on purpose: a missing location field is not a rejection. Ranking starts with
professional fit and seniority; confirmed geography is a tiebreaker after those signals.
This prevents incomplete LinkedIn remote metadata from burying a strong Senior React role.

Rules live in [src/eligibility.ts](src/eligibility.ts) with a `npm run sanity` check
covering one `high`, `medium` and `low` per source. Tweak the tokens to match your own
situation.

## Job sources

Three families, all behind `Promise.allSettled` so one dead source never breaks a search —
it shows up as a skip note instead.

**Polish IT boards** ([src/boards-pl.ts](src/boards-pl.ts)) — where the local market is, and
the only sources with pay per contract type:

| Source | Notes |
| --- | --- |
| [NoFluffJobs](https://nofluffjobs.com) | Default. One listing page (remote, senior, React) returns up to 100 postings; measured 62, pay on 60, B2B/UoP and per hour or month. Read from the page's `serverApp-state` |
| [justjoin.it](https://justjoin.it) | Default. Two listing pages (remote, senior, JavaScript), 86 offers measured; pay per contract type, `workplaceType`, level. Read from the Next.js flight data. Its `publishedAt` is bumped on every refresh, so the older of its two stamps is used |

Both boards' JSON APIs are disallowed in robots.txt; the listing pages are allowed, so those
are what is read — once per pass, not once per query (`PER_PASS_SOURCES`). Their copy of a
role goes first in dedupe, so the published pay survives. A page that parses to nothing is
reported as skipped. The URLs are `POLISH_BOARDS` in profile.ts.

**Company watchlist** ([src/watchlist.ts](src/watchlist.ts)) — chosen companies' own boards,
read through their ATS's public API (Greenhouse, Lever, Ashby), once a day. Product
companies post there first and often nowhere else; on 2026-10-23 the 16 boards in
`WATCHLIST` (profile.ts) gave 18 engineering roles open to Poland, Elastic's with published
PLN ranges. A company board lists every role it has, so only engineering titles that pass
the fit filter and are not out of geographic reach are kept. Region comes from the posting's
own location (Greenhouse office groups like "EMEA" are ignored): Poland or a region including
it is confirmed, a bare "Remote / Global" is a check, any other named place is out. These
postings carry no board date — an open role on a company board is open — so their age is
when this tool first saw them. Add a company by its ATS slug.

**Scraped via [JobSpy](https://github.com/speedyapply/JobSpy)** (Python, optional) — this is
where the volume is:

| Source | Notes |
| --- | --- |
| **Indeed** | Default. ~60 jobs in ~1s, full descriptions on every job. `is_remote` is a substring test for "remote" in the body, so the text is read again for office days (src/workmode.ts). Real local market: "Warszawa, MZ, PL", "zdalnie, PL". **Country-scoped** — see below |
| **LinkedIn** | Opt-in. Measured at ~0.5s/job (25s for 50) and often omits `is_remote`, so cards say `geo check`; professional matches still rank normally. Worth it for coverage Indeed misses |
| glassdoor / zip_recruiter / google | Available, not default. US-centric; google needs its own query syntax |

**Free public feeds** (no Python, always available):

| Source | Notes |
| --- | --- |
| [Himalayas](https://himalayas.app) | Default. Some published salaries (any currency) and real `locationRestrictions`; supports server-side `q`, `seniority`, `worldwide`. The search API sends each posting's whole text, and it is stored: the posting pages answer even a real Chrome with Cloudflare's "Just a moment…", so this is the only copy Claude's verdict can read |
| [RemoteOK](https://remoteok.com) | Opt-in. First array element is legal metadata and is skipped. Content varies wildly |
| [Arbeitnow](https://www.arbeitnow.com) | Opt-in. EU/Germany focused |

`SEARCH_DEFAULTS.sources` is **nofluffjobs, justjoin, watchlist, indeed, linkedin, himalayas**.
`DEFAULT_SOURCES` (`indeed` + `himalayas`) is only the fallback for a caller that names none.

### JobSpy caveats worth knowing

- **No salary data at all.** Measured: 0 of 200 Poland postings from Indeed and LinkedIn had
  a salary, versus ~4 of 20 on Himalayas. That is why Himalayas stays in the default set.
- **Indeed is country-scoped.** It searches a national domain, so `location: "European Union"`
  returns zero. The country is derived from the location string
  (`"Berlin, Germany"` → `de.indeed.com`); for genuinely EU-wide search, add `linkedin`.
- **Boards block aggressively.** LinkedIn rate-limits around the 10th page from one IP, and
  every board caps a search at ~1000 results. HTTP 429 is handled as a skip.
- **Scrapers break** when sites change markup. This is not a stable API — if a source starts
  returning nothing, check for a `python-jobspy` update first.
- **Terms of service.** Scraping LinkedIn/Indeed is against their terms. This runs
  unauthenticated at personal volume, so an account ban is unlikely and an IP block is the
  realistic failure mode — but it is your call to make.
- **Weaker eligibility signal.** No per-country metadata, so the location text is all the
  scorer has (see the table above).

Jobs are deduped across sources by normalized URL, then by case-insensitive
`company + title`. That second key matters: Himalayas' offset pagination can return the
same job twice, and companies repost identical roles under different URLs — in testing,
20 of 39 results for one query were duplicates. The first copy wins, with two exceptions:
Himalayas lists one URL per country for the same role, so a copy open to Poland replaces
one restricted elsewhere (the role used to be dropped as out of reach when the UK copy came
first); and a surviving copy without pay takes the pay its duplicate published.

**Rate limits and outages** are handled: HTTP 429 and any other failure skip that source
with a note rather than throwing.

## Data model

Single table, `applications`. Statuses:
`applied | responded | screening | interview | offer | rejected | dropped | ghosted`.

Lifecycle: `applied → responded → screening → interview → offer / rejected`, with
`dropped` available as an exit from any of them.

**Three ways an application ends, kept apart on purpose:**

| | Meaning |
| --- | --- |
| `rejected` | they said no |
| `ghosted` | nobody said anything — derived, never stored |
| `dropped` | I walked away: lost interest, took something else, saw the salary |

`dropped` is the only ending that is your own doing, which is why it is not folded into
either of the other two. It also never stamps `response_at` — giving up is not a reply, and
counting it as one would quietly inflate the response rate. If they *had* already replied
before you dropped it, the timestamp is already set and still counts.

**Dismissed jobs live in their own table, not as a status.** A job you are not interested in
is not an application: putting it in the funnel would inflate the counts and fill the tracker
with things you never applied to. Keeping it separate also makes un-dismissing a plain
delete. The filter is applied in `searchForProfile()`, so both the dashboard and `find_jobs`
honour it without each having to remember.

**There is no pre-application stage.** A row in the funnel means you applied — `В воронку`
inserts straight as `applied`, and so does `log_found_jobs`. The old `saved` bookmark stage
is gone: it meant "have I applied to this?" needed two lookups, and every rate had to carve
it back out of the denominator. Every tracked row is now a real application, so
`rate = responded+ / everything`. A database written before the change has its `saved` rows
migrated to `applied` on open (see `migrate()` in [src/db.ts](src/db.ts)).

**`ghosted` is derived, never stored.** On every read, a row still at `applied` with no
`response_at`, applied more than `staleDays` ago (default 21), is presented as `ghosted`.
Change `staleDays` and the same data re-reads differently — nothing to migrate.

Moving an application to any status that means they replied — `responded`, `screening`,
`interview`, `offer`, `rejected` — auto-stamps `response_at` if it isn't already set, which
is what feeds the response-rate and days-to-response stats. `dropped` is the exception.

## Dashboard API

| Route                                | Purpose                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| `GET /`                              | The HTML page (Search + Tracker tabs)                       |
| `GET /pico.css`                      | Pico CSS, read from `node_modules` at boot — form controls for the toolbar |
| `GET /api/search`                    | `?includeDismissed=1`, `?hoursOld=N` and `?sources=a,b` optional — runs the profile search server-side and echoes the profile it actually used |
| `POST /api/dismissed`                | `{ url, title?, company?, reason? }` → hide a job from every search |
| `DELETE /api/dismissed`              | `{ url }` → restore it |
| `GET /api/dismissed`                 | Everything currently hidden |
| `GET /api/stats`                     | Funnel counts + rates                                       |
| `GET /api/applications`              | All rows, `ghosted` applied                                 |
| `POST /api/applications`             | `{ url, title, company, source?, location?, salary?, status? }` → adds as `applied` |
| `POST /api/applications/:id/status`  | `{ status, responseAt? }`                                   |
| `POST /api/verdict`                  | `{ key }` → queue Claude's verdict on a stored job (202)    |
| `GET /api/verdicts`                  | `?since=<iso>` optional — verdicts made after it, and what the queue is doing |
| `POST /api/verdict/open`             | `{ key }` → open that verdict's session in Claude Desktop; this computer only |

`POST /api/applications` is idempotent on the job's key (below): re-adding returns `200` with
`result: "already_tracked"` instead of an error, which is why the Search tab can safely show
a card as "✓ В воронке" rather than failing.

Binds to `127.0.0.1` by default (`Job Hunt.bat` binds `0.0.0.0`, for phones on the same
Wi-Fi). There is no login by design — it is a single-user tool — so the guard is against
the browser: any web page you visit can send requests to localhost. Requests whose `Host`
is not this machine (localhost, a private LAN address, its own name) get 403, which stops
DNS rebinding; writes must be `application/json` (a cross-site page cannot send that
without a CORS preflight, which is never approved) and, when they carry an `Origin`, come
from the same host. Before this, a cross-site `text/plain` POST could write a dismissal.
The page's assets come from `node_modules` over the same local server, so the dashboard
works with the network down.

### Why Pico, and only in the toolbar

The search toolbar uses [Pico CSS](https://picocss.com) for its form controls — real
`fieldset`/`legend` grouping, radio groups, and switches, rather than hand-rolled
`div`s. It is the **conditional** build, whose rules only apply inside an element with
class `.pico`, and that is deliberate: the cards, funnel bars, status table and job grid
already have a complete design in `dashboard.ts`, and a classless framework would restyle
all of it on the way past. Pico's `--pico-*` tokens are remapped to the page's own palette
at the top of the stylesheet, so the toolbar reads as part of the page rather than as a
widget dropped onto it.

If the rest of the page should move onto Pico too, that is a separate pass — a bigger one,
because it means giving up the current card and funnel styling, not adding to it.

### Job identity and stored postings

Jobs are compared by `jobKey(url)` ([src/jobkey.ts](src/jobkey.ts)), never by the
raw URL: host + path + query without tracking parameters (`utm_*`, `source`,
`ref`, `gh_src`, …), lowercased. Boards add and drop those parameters — Himalayas
started appending `?utm_source=api` to every link in October 2026, which brought
every job hidden or applied to before that back as new. Identifying parameters
(`?id=`, `?oid=`, `career_job_req_id=`) are kept, because stripping the whole
query merged distinct roles. Both tables carry a `url_key` column, filled on open
for older rows; dedupe, the dismissed filter and "already applied" all use it.

**Searches read stored postings, not the boards.** [src/refresh.ts](src/refresh.ts)
fetches each board on its own schedule into the `postings` table, and
`/api/search` ranks what is stored: ~25 ms per search (~160 ms for the first one
after a refresh), where asking the boards cost ~4 s, ~80 s with LinkedIn, after
every restart, hide, date chip or source pill. The ranked feed is kept until any
board's refresh finishes — counted, not read off the highest run id: boards are
fetched side by side and finish out of order, and a feed built between Himalayas
finishing and Indeed finishing used to keep missing Indeed until the next pass.

| Board | Refresh |
| --- | --- |
| nofluffjobs, justjoin, indeed, himalayas | a full month-wide pass every 6 h (`JOBHUNT_REFRESH_HOURS`), ~2–5 s each. ↻ Обновить runs it now |
| watchlist | daily, ~10 s for 16 boards |
| linkedin | at most once a day, only what is new since its last success (`hoursOld`), one query at a time; a day off after HTTP 429. ↻ Обновить does not force it |

The dashboard runs it at start and checks what is due every 15 minutes; the very
first search on an empty table waits for each board's first pass. While the
dashboard is closed, `npm run refresh` does the same once — e.g. from Task
Scheduler:

```
schtasks /create /tn "JobHunt\Refresh" /sc hourly /mo 3 /tr "cmd /c cd /d D:\Projects\job-search && npm run refresh"
```

The table is board data, not applications — the Tracker and the stats never read
it, so the funnel stays applications-only (the removed `npm run harvest` filed
finds into the funnel; this does not). It keeps `first_seen` per posting: boards
re-stamp their dates on every renewal (Himalayas every 30 days, justjoin.it on
each refresh), so a card's age is the earlier of the board's date and when this
tool first saw it, a later board date shows as "перевыложена", and **новая**
marks what appeared since the Search tab was last opened — also counted in the
browser tab title, "(N) Job Hunt". A posting a fully fetched board stops listing
is dropped three days after that board's last good pass; LinkedIn's age out
after 45 days.

Hidden jobs, the date window and the screening rules are applied per request on
top of the stored feed, so none of them asks a board.

## Using the Search tab

1. Open <http://localhost:4321> and click **Search**. It runs automatically the first time.
2. Press **↻ Обновить** whenever you want a fresh pass. There is nothing to type.
3. Cards show title, company, salary, source, the professional match (`high` / `medium`),
   numeric **fit**, a separate `geo confirmed` / `geo check` signal, age, and a link to the
   real posting. Jobs are dropped before you see them if eligibility is `low` or the profile
   fit is neutral/poor (no target signal, wrong stack, junior, or non-engineering).
4. Click **В воронку** to record an application. It goes in as `applied` — there is no
   bookmark stage — and the card re-renders immediately, which means it **disappears on the
   spot** when *скрыть те, что в воронке* is ticked. Jobs already in your funnel render as
   **✓ Откликнулся** from the start.
5. Click **скрыть** on a card you are not interested in. It disappears and never comes back —
   not in the dashboard, not in `find_jobs`. Tick **показать скрытые** to review them and
   **вернуть** any you hid by mistake.
6. Tick **скрыть те, что в воронке** to drop cards you have already applied to, so only new
   candidates remain on screen.
7. **Опубликовано: 24 часа / 3 дня / неделя / 2 недели / месяц** narrows by posting age.
   A month is both the default and the ceiling — it is `SEARCH_DEFAULTS.hoursOld`, and the
   server clamps anything wider back down to it, so a hand-edited URL cannot widen the
   window either.

   It is a search *parameter*, not a filter over what came back: choosing an option re-runs
   the search with a smaller `hoursOld`. Filtering afterwards would be useless — the ranked
   list is capped at 40 and recency is only the fourth sort key, so a fresh-only filter over
   the top 40 usually returns nothing.

   The window is then enforced a second time in the page, because `hoursOld` only reaches
   the scraped boards and the free feeds ignore it — without that pass Himalayas alone would
   put month-old rows in a "24 hours" list. Postings that publish no date at all are dropped
   by that pass and counted in the line below the toolbar: a posting that will not say how
   old it is cannot be shown to be inside the window.
8. **The source pills** — one per board in `SEARCH_DEFAULTS.sources`, each
   showing how many postings it returned last time. They are a search
   parameter, so unticking one re-runs without it, and the server intersects
   the list with the profile's own: a hand-written URL can narrow the search
   but never make the dashboard scrape a board the profile never chose. At
   least one has to stay on.

   **LinkedIn is on by default and it is the slow one.** Measured on the same
   pass: `indeed + himalayas` takes ~3s, adding LinkedIn takes ~80s for ~900
   extra postings. Unticking it is how you get a fast search back. See *What
   each board is worth* below.
9. **The list loads lazily.** A search returns up to `SEARCH_DEFAULTS.limit`
   (200) ranked matches, and the page draws 24 at a time, extending as you
   reach the bottom — an `IntersectionObserver` on a sentinel below the grid,
   with a **Показать ещё** button in the same sentinel as the fallback. The
   sentinel also reads *показано N из M*, so a filtered-down list never just
   looks empty.

   The budget used to be 40, which was the actual bug: a pass keeps ~290 good
   matches after ranking and the page then hides more of them again (already
   applied to, dismissed, outside the date window), so you saw a dozen cards
   out of eight hundred fetched postings. Raising it costs nothing — no board
   comes close to the per-query cap, so nothing extra is fetched.
10. Two lines above the cards keep it honest: the profile line shows what was searched
   (`searching frontend developer · frontend engineer · react developer … in Poland, remote only
   · last 14d`), and the counts line shows what each source contributed and what was dropped
   (`indeed 529 · himalayas 297 → 292 eligible (826 fetched, 309 duplicates removed), 114
   dropped: wrong stack / junior`).

**The emphasis is frontend.** AI/LLM terms still score, but only as a bonus on top of a
frontend role — they used to be weighted as high as frontend itself and the feed filled up
with "AI Engineer" postings, which is not the job being searched for. ML and data-science
roles are penalised outright: the CV is LLM *integration* into products, not model training.
Backend is a positive signal inside a posting but a penalty in a title, since a "Senior
Backend Engineer" opening is off target even though the skills are there.

### What each board is worth

Measured against the live boards from Poland, not assumed. One profile pass,
ten queries, month-wide window:

| Board | Postings | Cost |
| --- | --- | --- |
| **indeed** | 1214 | part of the ~3s baseline |
| **himalayas** | 587 | part of the ~3s baseline |
| **linkedin** | 910 | takes the pass from ~3s to ~80s on its own |
| **glassdoor** | — | cannot be scoped to Poland at all. JobSpy throws `Glassdoor is not available for POLAND` in half a second |
| **zip_recruiter** | — | zero rows for Poland, and zero for `New York, NY` too, so it is not a geography problem: the scraper is dead in this JobSpy version |

The last two are not in `SEARCH_DEFAULTS.sources` and cannot usefully be added —
they would only ever produce a permanent "skipped" pill. `find_jobs` still
accepts them for a one-off search somewhere Glassdoor does serve.

Two things to know about LinkedIn specifically:

- **Nothing about it is unbounded.** Each query asks for `min(limit × 4, 200)`
  = 160 rows, and `hoursOld` reaches it exactly as it reaches Indeed (verified:
  under a 14-day window nothing older than 11 days came back). The cost is the
  ten entries in `TARGET_QUERIES` — LinkedIn answers at roughly 0.16s per job,
  and it is its own slow scrape per query. Shortening `TARGET_QUERIES` or
  lowering `SEARCH_DEFAULTS.limit` is what moves that number.
- **It ignores `remoteOnly`,** so leaving it on puts onsite Warsaw/Kraków roles
  in the feed. It also populates `is_remote` on essentially nothing (0 of 30
  even when `is_remote=true` is requested), so those cards show `geo check`.
  That uncertainty no longer overrides professional fit in ranking; the reason
  is still spelled out on each card.

`JOBHUNT_SOURCES=indeed,himalayas npm run dashboard` narrows the board list for
one run without editing the profile. `tests/ui.mjs` uses it to keep the suite
off the slow boards.

**The MCP `find_jobs` tool answers from the stored postings** when every board it
needs was fetched in the last day — instantly, LinkedIn included. Otherwise (a
different query or place, or stale data) it asks the boards live, and then
leaves LinkedIn out (`SEARCH_DEFAULTS.slowSources`): MCP times a request out at
60 s and a live LinkedIn pass takes ~80 s. Name `sources` explicitly to include
it anyway. Every argument is an override of the profile search, so queries,
remote-only, the fit filter, hidden jobs and the screening rules still apply.

## Claude's verdict on a card

The routine this replaces: open a posting from the Search tab, copy its whole text into
Claude, ask "does this fit me?". Now every card the Search tab shows gets that answer by
itself, in the background, within minutes of the posting appearing
([src/verdict.ts](src/verdict.ts)):

- **A chip in the card's top row** — `Claude ✓ 86` (apply), `Claude ? 64` (maybe: worth a
  look, something is unclear), `Claude ✗ 12` (skip) — and **a block above the buttons** with
  Claude's one-line summary and **почему**: the stop factors with a quote from the posting,
  the doubts, what matches. A dashed chip was judged under criteria that have changed since;
  the background queue redoes it (the card says so only where the queue will).
- **"skip" hides the card**, behind its own **скрыто Claude** toggle — the same way a rule
  hit sits behind **скрыто правилами**. Nothing is written to the hidden list: the toggle
  shows them all again, with **скрыть: \<reason\>** to hide one for good with Claude's reason
  (taken from the page's own one-click reasons, so it teaches the screening rules like a
  hand-picked one). A job already hidden or applied to stays under its own toggle whatever
  Claude said. **↻** asks again; a card without a verdict says **спросить Claude**.
- **Pay under the floor is a doubt, not a stop factor** — "maybe", score at most 55 — the
  same rule as the screening: such a card is flagged, never hidden, because some of those
  were applied to on purpose.
- **обсудить в Claude ↗** opens that verdict's own conversation in Claude Desktop, with the
  posting and the verdict already in it — ask about the stack, the money, a cover letter. It
  is the deep link `claude --desktop --resume` uses (`claude://resume?session=<id>`;
  Desktop imports the CLI session and focuses it). Without Desktop, a console window runs
  `claude --resume` with no tools. This computer only: that is where the window opens.
- **Claude: лучшие сверху** in the sort menu orders by verdict, then score. The line next to
  the match count says what the queue is doing (`· Claude оценивает 2, в очереди 30`, or why
  it is paused).
- The tray app's "N новых вакансий" leaves out postings Claude has called "skip" and names
  the ones it liked first, marked `✓`. `/api/new-count` also says how many new postings
  Claude is still judging (`pending`); a tray app built from this checkout waits for those,
  up to 15 minutes, so a posting about to be skipped is not announced (`cd desktop && npm run
  build`, then run the installer — the installed app carries its own copy of `main.mjs`).

**How.** The posting text — stored with the posting (Indeed, the company watchlist,
Himalayas), or read by `scripts/jobs-fetch.mjs` (LinkedIn's guest API, nofluffjobs,
justjoin.it, any ATS page) — goes to **headless Claude Code**, `claude -p`, with
[src/verdict-criteria.md](src/verdict-criteria.md) as the system prompt, and comes back as
JSON held to a schema (`--json-schema`). Claude Code rather than the API because it runs on
the Claude subscription already logged in on this machine: no API key, nothing billed per
call, and each verdict is a real session on disk that Desktop can open.

- **No tools, nothing from disk.** The posting is text from the web; the model only reads it
  and fills in the schema (`--tools ""`, `--strict-mcp-config`), in safe mode (`--safe-mode`:
  no CLAUDE.md, hooks, skills or settings from the folder it runs in). Everything the board
  said sits inside `<posting>…</posting>`, which the system prompt calls the employer's
  text, not instructions. The system prompt is written for each run outside the sessions'
  folder and deleted after it.
- **In Desktop the conversation has Desktop's usual tools** — the deep link cannot pass
  flags — and the posting is in it. The system prompt the session keeps still says what
  `<posting>` is; treat what the conversation suggests as you would any text from a job
  board. The console fallback resumes with no tools at all.
- **At most two `claude` processes and one page read at a time** (LinkedIn answers parallel
  reads with 429). The background queue takes only the cards the Search tab shows by
  default — default boards, month window, not hidden, not applied, not a rule hit — newest
  first, at most `JOBHUNT_CLAUDE_DAILY` (80) **runs** a day, redone and failed ones
  included. A queued card that gets hidden or applied to leaves the queue.
- **What stops the whole queue stops it, not a posting**: the plan's limit (Claude Code
  2.1.287 says `You've hit your session limit · resets 11pm` with `api_error_status` 429 —
  the queue sleeps until then), a lost login, a missing `claude`, an unreadable criteria
  file. The card that was running waits in the queue, and the line above the cards says
  why. A failure of the posting itself (no text, a timeout) is tried once more half an
  hour later; the card says what went wrong.
- **Stored per job** in the `verdicts` table, with the version of the criteria it was made
  under, the model, the session id, how much text Claude read and how long it took.
- **The criteria file is the thing to edit**: who I am, what I want, the stop factors, the
  fine print ("no salary in the text is normal — do not lower the verdict for it"). It is
  re-read on change, and every verdict made under the old text goes stale and is redone.
  The facts in it mirror `.claude/skills/job-apply/profile.json`; change both.
- Sessions live in their own folder, `~/.job-hunt/verdicts`, so they are one project in
  Claude Code's session list instead of hundreds of entries in this repo's. Claude Code
  deletes sessions after 30 days (`cleanupPeriodDays`); **обсудить** on an older verdict
  says so, and **↻** makes a new one.

**Measured** on 2026-10-23 against 28 postings already decided by hand — 14 applied to, 14
hidden — before pay under the floor became a doubt rather than a stop factor:

| | Sonnet, effort low (default) | Opus, effort low |
| --- | --- | --- |
| Applied-to postings called "skip" | 1 of 14 (its board lists USD 1.5k a year, and 3+ years) | the same one |
| Hidden postings called "skip" | 7 of 14 | 7 of 14 |
| Time | ~7 s a posting; 28 in 139 s, two at a time | 28 in 127 s |
| Usage, at API list price | $0.49 for the 28 | $0.92 |

The hidden ones Claude did not call "skip" were mostly hidden for what the text does not
carry — another role at the same company already applied to (the card's flag says so), or
no text at all. Two things the first pass got wrong and the criteria now say: Polish above
B1 as a requirement is a stop factor, and "do not invent checks the text is silent about"
(it asked about citizenship and contracts that no posting mentioned). A page that answers
with a bot check is now an error on the card ("не удалось прочитать вакансию"), not a
verdict on 338 characters of Cloudflare.

## Tuning what gets found

Everything personal is in [src/profile.ts](src/profile.ts):

| What | Why you would change it |
| --- | --- |
| `TARGET_QUERIES` | The searches the Refresh button runs. Nine, because no single keyword covers everything a frontend role gets titled — the same job is "Frontend Developer" at one company and "Web Engineer" at the next. Each line's measured marginal yield is in the comment above it; order is not a ranking signal |
| **The emphasis** | Currently **frontend**, with AI/LLM as a bonus rather than a target. Frontend terms carry the highest weights, fullstack counts less, and a backend-titled role is penalised. Shift it by editing the weights |
| `SEARCH_DEFAULTS` | Location, remote-only, how far back to look, which boards, how many results, and `maxFitTier` |
| `SEARCH_DEFAULTS.sources` | Which boards to query — and, one-for-one, the source pills the Search tab offers. The filter can only narrow this list |
| `STACK_WEIGHTS` | What counts as a good match. Taken from the CV; title matches count double, and available posting descriptions supply additional evidence |
| `FOREIGN_STACK` | What sinks a posting: .NET, Java, Angular, ML/data-science, backend-only titles, plus non-engineering roles like recruiter or designer. A title match counts triple |
| `JUNIOR_MARKERS` / `SENIOR_MARKERS` | Seniority detection, English and Polish |

Nothing else in the codebase encodes any of it.

In the **Tracker** tab each row carries one status control — the coloured dropdown *is* the
status display. There is no badge repeating the same word next to it, and no notes column:
notes are still stored and still written by `add_note`, they are just not what the table is
for. Above the individual statuses the Status filter offers one grouped shortcut:

- **open (в работе)** — still alive: `applied`, `responded`, `screening`, `interview`

No single status answers that, which is why it is its own option.

## Tests

```bash
npm test          # everything: typecheck, scorer checks, MCP, dashboard UI
npm run sanity    # eligibility + stack-fit scoring (fast, offline)
npm run test:mcp  # drives the real MCP server over stdio
npm run test:ui   # runs the real dashboard page JS against a real server
```

`test:mcp` and `test:ui` each spawn their own process against a throwaway database in the
temp directory — they never touch your real one. Both hit live job boards, so they need
network and take a few seconds. `test:ui` uses port 4399 and refuses to run if something else
holds it, rather than testing the wrong server (`TEST_PORT` overrides).

**`test:ui` earns its keep.** The dashboard page is a template literal inside `dashboard.ts`,
so a stray backtick or an unescaped `\"` is a syntax error that blanks the entire page and
`tsc` says nothing. That harness has caught exactly that twice, plus a bug where optional
arguments silently overwrote the search profile. Run it after touching `dashboard.ts`.

## Making it multi-device later

[src/db.ts](src/db.ts) is the only file that imports `better-sqlite3`. To reach this data
from other devices, swap that module's **bodies** for a Supabase/Postgres client and keep
the exported signatures — `insertApplication`, `updateStatus`, `addNote`,
`listApplications`, `getStats`, `findByUrl`. Nothing in the MCP server, the dashboard, or
the scorer needs to change. The derived-`ghosted` rule is plain logic in `decorate()` and
ports as-is.

## Project layout

```
src/
  profile.ts      WHO I AM: target searches, location, stack weights. Edit this
  db.ts           SQLite open + schema + all data-access functions
  jobspy.ts       bridge to the Python JobSpy scraper (Indeed, LinkedIn, ...)
  sources.ts      fetch + normalize every source, dedupe
  eligibility.ts  "can I apply from Poland?" scorer + sanity checks
  pipeline.ts     searchJobs(): the ONE search pipeline both callers use
  index.ts        MCP server: 8 tools over StdioServerTransport
  dashboard.ts    node:http server on :4321 (Search + Tracker)
  verdict.ts      Claude's verdict on a posting: `claude -p`, the queue, "обсудить в Claude"
  verdict-criteria.md  WHAT I WANT, in words: the brief Claude judges postings by. Edit this
scripts/
  jobspy_fetch.py the Python half of the JobSpy bridge
tests/
  mcp.mjs         drives the MCP server over stdio
  ui.mjs          runs the real page JS against a real server
  fake-claude.mjs stands in for `claude -p` in ui.mjs: offline, free
```

`pipeline.ts` owns fetch → dedupe → score → filter → rank. `index.ts` and `dashboard.ts`
only format its output; neither re-implements any of it. Change ranking or filtering there
once and both surfaces follow.

## Notes and gotchas

- **Himalayas 503 workaround:** `q` + `sort=relevant` + `page=1` reliably returns HTTP 503
  upstream, while the same request without `page` returns 200. Since `page=1` is the server
  default, it is omitted. See the comment in `fetchHimalayas`.
- **Feed timestamps differ:** Himalayas `pubDate` and Arbeitnow `created_at` are UNIX
  seconds; RemoteOK `date` is an ISO string. All are normalized to ISO.
- **RemoteOK content varies wildly.** Its public endpoint returns only the latest ~100
  postings, which are sometimes dominated by non-developer listings. A search may
  legitimately return nothing from it — check the per-source counts in the `find_jobs`
  response.
- **Eligibility is a filter, not legal advice.** It reads what the feeds publish. Always
  confirm on the posting itself before investing time in an application.
- `find_jobs` deliberately over-fetches (3 Himalayas pages) because eligibility filtering
  removes roughly 90% of a text search's results.
- **The JobSpy bridge passes results through a file, not stdout.** JobSpy and its HTTP stack
  log to the console, and a stray log line would corrupt a stdout JSON stream.
- **UTF-8 is forced on the Python child** (`PYTHONIOENCODING`, `PYTHONUTF8`). Without it,
  Polish listings (ł, ę, ó) raise `UnicodeEncodeError` on the Windows cp1252 console — this
  bit during development and looked like a scraper failure.
- **Ranking**: fit tier; then published pay under the floor (`SALARY` in profile.ts, 25k PLN
  B2B-equivalent a month — hourly ×168, UoP gross ×0.81 — my own 34k UoP = 27.5k B2B, static FX) to the end of its tier;
  then fit band and seniority; then postings whose text asks for office days or fluent
  Polish; then eligibility confidence and recency. A junior title or a foreign stack in the
  title is tier 3 outright — a body full of React cannot lift it. An AI title with no
  frontend/fullstack/web in it is capped at tier 1, after the frontend roles. A title that
  names no level falls back to the board's own (Himalayas tags, nofluffjobs / justjoin.it
  levels): Senior ranks as senior, Mid-level/Entry-level just below "unstated".
- **`minSalary`** (find_jobs) is PLN per month, B2B-equivalent, in the same unit as the floor
  — it used to compare monthly and foreign figures with an annual number.
- **Screening rules run inside the search** ([src/screening.ts](src/screening.ts), lists in
  profile.ts): the same rules as `funnel.mjs screen`, applied at read time against the funnel
  and the hidden list. Hits stay behind the **скрыто правилами** toggle with their reason;
  nothing is written to `dismissed`. Hides written by a rule never count as evidence, and a
  role like one already applied to is a flag on the card, not a hide. "скрыть ▾" takes a
  one-click reason; "не интересна компания" hides that company everywhere.
- **Stack keywords come from the CV**, weighted, in `sources.ts`. That list is the single
  place that encodes "what I actually do" — edit it to change what ranks highly.

## Applying by script

Three skills under `.claude/skills/` drive the whole pass without the browser
extension: **job-screen** (rules + hide), **job-apply** (one application),
**job-pipeline** (the daily run). They are thin wrappers over four scripts:

| Script | Does |
| --- | --- |
| `scripts/funnel.mjs` | CLI over the dashboard API: `search`, `screen [--commit]`, `dismiss`, `undismiss`, `add`, `applied`, `dismissed`, `stats`, `status` |
| `scripts/jobs-fetch.mjs` | Reads postings without a browser (board JSON APIs, LinkedIn guest API, stripped HTML, Chrome only for JS-only pages) and prints one line per job: work mode, stack, level, language/country constraints, ATS, form questions |
| `scripts/apply.mjs` | Fills and submits one application with Playwright on the installed Chrome; records it via `POST /api/applications`; exit codes for missing answers, account walls, CAPTCHAs, e-mailed verification codes |
| `scripts/apply-batch.mjs` | Runs `apply.mjs` over a list, one result line per job |

**From the dashboard:** "Подать" on a card runs `apply.mjs` for that job through the server
([src/apply-runner.ts](src/apply-runner.ts)). It always starts as a dry run — the form is
filled, nothing is sent, and the panel lists every field and value — and only then offers
"Отправить отклик". The server refuses a submit that was not preceded by a dry run of the
same job within 30 minutes, runs one application per Chrome profile at a time, and accepts
the request only from this computer (the Chrome window, and the Greenhouse code typed into
it, are here). A posting whose published pay is under the floor asks "Всё равно подать?"
first; such pay is also flagged on its card. A submitted application lands in the funnel
by itself, with the posting's date (the Tracker shows how many days after publication it
went out); anything short of that
— a code, a CAPTCHA, an account wall, a missing answer — lands under **нужно вам** on the
Search tab and in `node scripts/funnel.mjs attempts`, until the job is applied to or hidden.

Facts the forms ask for live in `.claude/skills/job-apply/profile.json`. Chrome
profiles: `~/.job-hunt/chrome-profile` (LinkedIn, log in once with
`node scripts/apply.mjs --login`) and `~/.job-hunt/chrome-profile-ats` (all
other boards). The scripts never create accounts, never type passwords, never
solve CAPTCHAs and never read verification codes from the mailbox — those
steps are handed back to you.
