# job-hunt

A personal, local-only MCP server + web dashboard for finding remote jobs you can
actually apply to **from Poland (EU)**, and tracking what happened to each application.

No cloud, no accounts, no API keys, no paid services. One SQLite file on your disk.

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
| `JOBHUNT_SEARCH_CACHE_MINUTES` | `60`                 | Dashboard search cache TTL, in minutes |

### Windows app

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

Two families, all behind `Promise.allSettled` so one dead source never breaks a search —
it shows up as a skip note instead.

**Scraped via [JobSpy](https://github.com/speedyapply/JobSpy)** (Python, optional) — this is
where the volume is:

| Source | Notes |
| --- | --- |
| **Indeed** | Default. ~60 jobs in ~1s, full descriptions on every job, `is_remote` reliably set. Real local market: "Warszawa, MZ, PL", "zdalnie, PL". **Country-scoped** — see below |
| **LinkedIn** | Opt-in. Measured at ~0.5s/job (25s for 50) and often omits `is_remote`, so cards say `geo check`; professional matches still rank normally. Worth it for coverage Indeed misses |
| glassdoor / zip_recruiter / google | Available, not default. US-centric; google needs its own query syntax |

**Free public feeds** (no Python, always available):

| Source | Notes |
| --- | --- |
| [Himalayas](https://himalayas.app) | Default. The **only** source with published salaries and real `locationRestrictions`; supports server-side `q`, `seniority`, `worldwide` |
| [RemoteOK](https://remoteok.com) | Opt-in. First array element is legal metadata and is skipped. Content varies wildly |
| [Arbeitnow](https://www.arbeitnow.com) | Opt-in. EU/Germany focused |

Default set is **`indeed` + `himalayas`**: volume from one, salary and worldwide-remote from
the other, ~1 second total.

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
20 of 39 results for one query were duplicates.

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

`POST /api/applications` is idempotent on `url`: re-adding returns `200` with
`result: "already_tracked"` instead of an error, which is why the Search tab can safely show
a card as "✓ В воронке" rather than failing.

Binds to `127.0.0.1` only. There is no auth by design — it is a single-user local tool.
Nothing is fetched off the machine: the one stylesheet comes from `node_modules` over the
same local server, so the dashboard works with the network down.

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

**The MCP `find_jobs` tool leaves LinkedIn out**, listed in
`SEARCH_DEFAULTS.slowSources`. That is a constraint, not a preference: MCP times
a request out at 60s and a pass with LinkedIn takes ~80s, so including it would
fail outright rather than answer slowly. The dashboard can afford it — it shows
progress and the pill drops the board in one click. Name `sources` explicitly on
`find_jobs` if you want LinkedIn from an assistant and can wait.

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
scripts/
  jobspy_fetch.py the Python half of the JobSpy bridge
tests/
  mcp.mjs         drives the MCP server over stdio
  ui.mjs          runs the real page JS against a real server
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
- **Ranking starts with stack fit and seniority**, then eligibility confidence and recency.
  It demotes junior titles in English and Polish
  (`intern`, `junior`, `praktyk`, `staż`, `młodszy`). Scraped boards accept no seniority
  filter, so without this a fresh internship outranks a staff role.
- **Stack keywords come from the CV**, weighted, in `sources.ts`. That list is the single
  place that encodes "what I actually do" — edit it to change what ranks highly.
