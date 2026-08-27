# job-hunt

A personal, local-only MCP server + web dashboard for finding remote jobs you can
actually apply to **from Poland (EU)**, and tracking what happened to each application.

No cloud, no accounts, no API keys, no paid services. One SQLite file on your disk.

The flow is **search → see eligible jobs → drop them into the funnel**, from either the
assistant or the browser.

- **MCP server** — 7 tools your AI assistant can call (`find_jobs`, `log_found_jobs`,
  `log_application`, `update_status`, `add_note`, `list_applications`, `get_stats`).
- **Dashboard** — two tabs at <http://localhost:4321>: **Search** (live job search with
  one-click "add to funnel") and **Tracker** (funnel + sortable application table).
- **Eligibility scoring** — every job is tagged `high` / `medium` / `low` for whether a
  Poland-based candidate can apply, with a reason.

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
```

`npm run mcp` speaks the MCP protocol on stdin/stdout, so running it by hand just looks
like it hangs — that's correct. Point a client at it instead.

There is no build step; `tsx` runs the TypeScript directly.

### Environment

| Variable       | Default              | Purpose                        |
| -------------- | -------------------- | ------------------------------ |
| `JOBHUNT_DB`   | `~/.job-hunt/jobs.db` | SQLite file (dir auto-created) |
| `JOBHUNT_PORT` | `4321`               | Dashboard port                 |

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

- "Find senior react remote jobs I can apply to from Poland"
- "Find fullstack typescript jobs, worldwide only, at least 120k"
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
> **Assistant:** *(calls `log_found_jobs`)* — 4 added as `saved`, 0 already tracked.

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

`find_jobs` drops `low` by default (`onlyEligible=true`). `medium` is kept on purpose: a
missing location field is not a rejection. Results are ranked `high` → `medium`, then most
recently posted, then a small boost for `react` / `next` / `typescript` / `fullstack` /
`frontend` / `node`.

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
| **LinkedIn** | Opt-in. Measured at ~0.5s/job (25s for 50) and sets `is_remote` on ~1 job in 50, so results score `medium` and rank low. Worth it for EU-wide search, which Indeed cannot do |
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
`saved | applied | responded | screening | interview | offer | rejected | ghosted`.

Lifecycle: `saved → applied → responded → screening → interview → offer / rejected`.

**`saved` is pre-application** — "found it, haven't applied yet". It is what jobs added from
search get, from both the Search tab and `log_found_jobs`. Because finding a job is not
applying to one, `saved` is **excluded from the response-rate and ghost-rate denominators**
(`rate = responded+ / applied+`); adding 50 jobs from search will not dilute your response
rate to 2%. To change that default, edit the one insert path — `status` in `log_found_jobs`
and the `POST /api/applications` fallback.

**`ghosted` is derived, never stored.** On every read, a row still at `applied` with no
`response_at`, applied more than `staleDays` ago (default 21), is presented as `ghosted`.
Change `staleDays` and the same data re-reads differently — nothing to migrate.

Moving an application to any status past `applied` auto-stamps `response_at` if it isn't
already set, which is what feeds the response-rate and days-to-response stats.

**Leaving `saved` re-stamps `applied_at` to now.** A job saved from search six weeks ago and
applied to today is measured from today. Without this, it would report a 42-day
`daysSinceApplied` and be derived as `ghosted` the instant it reached `applied`.

## Dashboard API

| Route                                | Purpose                                                     |
| ------------------------------------ | ----------------------------------------------------------- |
| `GET /`                              | Self-contained HTML page (Search + Tracker tabs)            |
| `GET /api/search`                    | `?q, seniority, worldwideOnly, minSalary, sources, limit` — runs `searchJobs()` server-side |
| `GET /api/stats`                     | Funnel counts + rates                                       |
| `GET /api/applications`              | All rows, `ghosted` applied                                 |
| `POST /api/applications`             | `{ url, title, company, source?, location?, salary?, status? }` → adds as `saved` |
| `POST /api/applications/:id/status`  | `{ status, responseAt? }`                                   |

`POST /api/applications` is idempotent on `url`: re-adding returns `200` with
`result: "already_tracked"` instead of an error, which is why the Search tab can safely show
a card as "✓ В воронке" rather than failing.

Binds to `127.0.0.1` only. There is no auth by design — it is a single-user local tool.

## Using the Search tab

1. Open <http://localhost:4321> and click **Search**.
2. Type a query (optionally set seniority, a salary floor, or *worldwide only*) and submit.
3. Cards show title, company, salary, source, the eligibility badge and its reason, plus a
   link to the real posting. `low`-eligibility jobs are filtered out before you see them.
4. Click **В воронку** to add a job as `saved`. The button becomes **✓ В воронке** and
   disables. Jobs already in your funnel render that way from the start.
5. The per-source line (`himalayas 60 · remoteok 14 · arbeitnow 36 → 21 eligible`) shows what
   each feed contributed, so a feed returning nothing — or being rate-limited — is visible
   rather than mysterious.

In the **Tracker** tab, `saved` rows are dimmed and labelled "saved, not applied" to keep
them distinct from real applications. Use the status dropdown on a row to move it to
`applied` when you actually apply, or the Status filter to view one stage at a time.

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
  db.ts           SQLite open + schema + all data-access functions
  jobspy.ts       bridge to the Python JobSpy scraper (Indeed, LinkedIn, ...)
  sources.ts      fetch + normalize every source, dedupe
  eligibility.ts  "can I apply from Poland?" scorer + sanity checks
  pipeline.ts     searchJobs(): the ONE search pipeline both callers use
  index.ts        MCP server: 7 tools over StdioServerTransport
  dashboard.ts    node:http server on :4321 (Search + Tracker)
scripts/
  jobspy_fetch.py the Python half of the JobSpy bridge
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
- **Ranking demotes junior titles** ahead of recency, in English and Polish
  (`intern`, `junior`, `praktyk`, `staż`, `młodszy`). Scraped boards accept no seniority
  filter, so without this a fresh internship outranks a staff role.
- **Stack keywords come from the CV**, weighted, in `sources.ts`. That list is the single
  place that encodes "what I actually do" — edit it to change what ranks highly.
