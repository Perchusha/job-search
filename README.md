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
- **Dashboard** — two tabs at <http://localhost:4321>: **Поиск**, a stack you go through one
  posting at a time with Claude's verdict on each, and **Отклики** (where the applications
  stand, and the list of them).
- **Separate signals** — the profile match and the geography check still rank and filter the
  feed; Claude's verdict, read from the whole posting, decides which stack a card is in.

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
| `JOBHUNT_CLAUDE_AUTO`          | on                   | `0` stops Claude judging the Search tab's cards in the background; the card button still works. This and the next two are only defaults: **Настройки → Claude** overrides them |
| `JOBHUNT_CLAUDE_MODEL`         | `sonnet`             | Model for the verdicts (`opus` reads closer, counts heavier against the plan) |
| `JOBHUNT_CLAUDE_EFFORT`        | `low`                | Effort for the verdicts (`low`…`max`); the user settings' `xhigh` is for coding sessions |
| `JOBHUNT_CLAUDE_DAILY`         | `80`                 | Most verdicts the background queue makes in a day; manual ones are not counted |
| `JOBHUNT_CLAUDE`               | `claude` on PATH     | Path to the Claude Code executable (a `.mjs` runs under Node — the tests' stand-in) |

The Claude settings saved from the page live in the database (`meta.claude_settings`), so they
survive restarts and win over the variables; **Настройки → Claude** also shows today's
background runs and has **Оценить оставшиеся сейчас**, which queues every shown card without
a current verdict as a manual request — outside the daily cap.

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
- settings are in the dashboard's own **Настройки** (the avatar menu in the window): theme,
  Claude, and — in the app only — autostart, refresh interval, LinkedIn in the background,
  notification threshold, quiet hours, digest time, port, Wi-Fi access. The app part goes
  through the preload bridge (`window.jobHunt`, exposed to the local dashboard only; the
  window refuses to navigate anywhere else) and is stored in
  `%APPDATA%\Job Hunt\settings.json`; the log is `job-hunt.log` next to it. The tray has no
  settings of its own: with the server down there is no page to show them, so a wrong port
  is fixed in that file.

```bash
cd desktop
npm install          # Electron and electron-builder, kept out of the main package
npm start            # run from the checkout
npm run build        # dist/Job Hunt Setup 1.0.0.exe — per-user installer, no admin rights
```

The installed app does not carry a copy of the project: it starts `src/dashboard.ts` from this
repo (the path is baked in by `build.mjs`; `JOBHUNT_REPO` overrides it) with the `node` on
PATH, so moving the repo means rebuilding. The installer is unsigned, so SmartScreen asks once.
Windows' own notification switch must be on (Settings → System → Notifications); the tray menu
and Настройки say when it is off and open that page.

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
| **Himalayas** | no `locationRestrictions`, or a friendly token   | open worldwide, but only in American time zones (`timezoneRestrictions`) | lists only non-EU countries          |
| **RemoteOK**  | `location` has a friendly token                 | empty or unrecognized location          | US/Canada/Americas only              |
| **Arbeitnow** | `remote === true` (EU, same timezone as Poland)  | onsite inside Poland                     | onsite outside Poland                |
| **Jobicy**    | the regions listed include Poland, Europe, EMEA or anywhere | no region listed | other countries only |
| **Workable**  | remote, listed in Poland                         | listed in Poland, but hybrid/onsite or office days in the text | listed in another country |
| **Hacker News** | remote, and the header says Europe, worldwide, CET/UTC± or Poland | remote, no region in the header | remote in the Americas or within one other country; onsite outside Poland |
| **Djinni**    | remote, open to Europe or Poland                 | remote with no region; an office in Poland | remote within Ukraine or another single country; an office elsewhere |
| **DOU**       | remote «за кордоном» (from abroad) or in a Polish city | remote with no country (often Ukraine only); an office in Poland | an office in Ukraine |
| **Indeed / LinkedIn / other scraped** | remote **and** a Poland/EU location; LinkedIn: a card naming only the country or region, or no place | remote elsewhere (may require local tax residency), onsite in Poland, or no location stated | onsite outside Poland |

A Polish city, metro area or voivodeship counts as Poland ("Wroclaw Metropolitan Area",
"Warsaw" on a company board). LinkedIn's remote search shows a card's place as "Poland",
"European Union" or a city; JobSpy used to drop the one-part ones, so 185 of 723 rows had no
place at all — `scripts/jobspy_fetch.py` keeps them now. Such a country-wide card is a remote
role open to the whole country (14 of 22 judged ones remote by their text, none asking for an
office); a card naming a city is where the office days were (17 of the 18 "не remote" skips).
The verdict's «Где» takes the page's own place when the board gave none, and keeps it: the place
is saved with the page's text (`posting_texts.location`), so a re-judge from the saved text
has it too — without it Kraken's remote role was doubted "open from Poland?" on 2026-10-25 —
and the Search card shows it. For a LinkedIn posting the prompt adds that «Где» is where the
employer filed it, remote ones included, so a city there is no office: the format comes from
the text. (LinkedIn's own "Remote" chip shows only to a logged-in session; the public page
has no work mode, and its search does not keep to the remote filter.)

One exception to remote-only: the giants listed in **Настройки → Мои условия** (Google,
Apple, Netflix, Meta, Microsoft, Amazon, Nvidia, subsidiaries named; `OFFICE_OK` in
src/profile.ts reads them). Their hybrid or onsite roles in the city named there
(**Warsaw**) score `high`, are not demoted for office days, are not hidden by the Indeed
onsite rule, pass the stack-fit filter unless the title itself rules them out (their titles
name no stack and their requirements list languages — "Java, C++, Python or Go" — which cut
10 of 13 such postings in a month before Claude saw them), are never blocked as a company
by hides without a reason, and `apply-batch.mjs` passes `--office-ok` so LinkedIn's Hybrid tag does
not stop the script. LinkedIn is also asked for them by name once a day, beside the remote
queries (`OFFICE_OK.linkedin`: one OR-query, Warsaw, not remote; rows that are not a giant's
Warsaw office are dropped) — the remote queries let such roles through only by accident. The same giant in Kraków stays `medium`: no relocation. Claude's criteria get the
same list from the same place (see «Мои условия» below).

### «Мои условия» — the terms the rules and Claude share

**Настройки → Мои условия** ([src/preferences.ts](src/preferences.ts), stored in DB meta
`preferences`): the pay floor (B2B net a month), my UoP↔B2B equivalence (34 000 gross on UoP is
worth 27 500 on B2B), paid hours in a month, the companies whose office roles are fine and
the city, and my Polish level. They used to be written several times over: the floor as a
constant and as ten hand-converted numbers in the criteria, the giants as a regex, a list
in the criteria and a line in profile.json, the Polish level as a regex that, unlike the
criteria, did not count B2 — the giants exception alone touched 13 files. Now the code reads
them (the floor and the "below / middle below" flags, the office exception and LinkedIn's
query for it, the Polish rule — B2 moves the stop to C1, C1 removes it), and
src/verdict-criteria.md gets them as a generated last section, «Условия из Настроек», with
the floor in EUR, USD, per year and per hour. A save rebuilds the feed and changes the
criteria version, so verdicts are redone as «После правки критериев» says. The dashboard,
the MCP server and `npm run refresh` read the stored values; anything without a database
(the tests) works with the defaults — the values hard-coded before. The facts forms are
filled from (the asks, notice, work permit) stay in `.claude/skills/job-apply/profile.json`.

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
read through their ATS's public API (Greenhouse, Lever, Ashby, and since 2026-10-30 Workable,
SmartRecruiters and Recruitee), once a day. A company's own text about its product does not
count against a role ("recruiter" at Ashby, which sells recruiting software); a foreign stack in it
still does. Product
companies post there first and often nowhere else; on 2026-10-23 the 16 boards in
`WATCHLIST` (profile.ts) gave 18 engineering roles open to Poland, Elastic's with published
PLN ranges. A company board lists every role it has, so only engineering titles that pass
the fit filter and are not out of geographic reach are kept. Region comes from the posting's
own location (Greenhouse office groups like "EMEA" are ignored): Poland or a region including
it is confirmed, a bare "Remote / Global" is a check, any other named place is out. These
postings carry no board date — an open role on a company board is open — so their age is
when this tool first saw them. Add a company by its ATS slug.

**Two more boards** ([src/boards-intl.ts](src/boards-intl.ts)), added on 2026-10-30, once per pass:

| Source | Notes |
| --- | --- |
| [Jobicy](https://jobicy.com) | Default. The public API with `geo=poland&industry=dev`: roles open to Poland, Europe, EMEA or anywhere (61 on 2026-10-30), with the whole text and sometimes pay. Its terms ask for credit and a link to the posting: the card links to the Jobicy page |
| [Workable](https://jobs.workable.com) | Default. The public search API, `location=Poland&workplace=remote`, for each term in `WORKABLE_QUERIES` (profile.ts) one after another, up to 3 pages. Sends the whole text. `created` is the age (`updated` moves); postings older than the window are dropped at fetch, since a listing kept open for a year is still listed. robots.txt disallows only `/search` with a query |
| [HN: Who is hiring](https://news.ycombinator.com/submitted?id=whoishiring) | Default, daily. The latest monthly thread via hn.algolia.com; each top-level post is one card, company and role from its header line ("Company \| Role \| REMOTE (EU) \| …"), the post itself the text Claude reads. Only posts not ruled out by region or title are stored (October 2026: 32 of 262). A post describes the company and all its roles, so stacks in its body do not count against the title's |

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
| [Himalayas](https://himalayas.app) | Default. Some published salaries (any currency) and real `locationRestrictions`; supports server-side `q`, `seniority`, `worldwide`. The background refresh asks twice per query — as before and `worldwide=true` (one after the other, retried once after HTTP 429): its 60 rows a query were 90% roles restricted to one country other than Poland (426 of 474 stored). Live searches (`find_jobs` on stale data) ask once. The search API sends each posting's whole text, and it is stored: the posting pages answer even a real Chrome with Cloudflare's "Just a moment…", so this is the only copy Claude's verdict can read |
| [RemoteOK](https://remoteok.com) | Opt-in. First array element is legal metadata and is skipped. Content varies wildly |
| [Arbeitnow](https://www.arbeitnow.com) | Opt-in. EU/Germany focused |

**Ukrainian boards** ([src/boards-ua.ts](src/boards-ua.ts)), added on 2026-10-30, once per pass. The Belarusian
ones were checked and are empty (jobs.devby.io: 6 vacancies in all; rabota.by is hh.ru, whose API answers 403 without a registered app).

| Source | Notes |
| --- | --- |
| [Djinni](https://djinni.co) | Default. Listing pages per `DJINNI_KEYWORDS` (React.js, JavaScript, Fullstack), 15 postings a page, one second apart; each posting is JSON-LD with the whole text, `applicantLocationRequirements` and sometimes pay. 168 in a month: 65 open to Europe, 7 to Poland, 57 Ukraine only. Postings out of reach are not stored |
| [DOU](https://jobs.dou.ua) | Default. RSS feeds in `DOU_FEEDS` (remote Front End, Fullstack, JavaScript, "react"; Warsaw offices), 25 latest each, whole text. The title carries place and pay: "Role в Company, до $5000, за кордоном, віддалено" |

`SEARCH_DEFAULTS.sources` is **nofluffjobs, justjoin, watchlist, workable, jobicy, djinni, dou, indeed, linkedin, himalayas, hackernews**.

Настройки → Поиск shows, per board, the cards on screen, how many of them Claude took (apply or
maybe), and how many are **only there**: every copy dedupe folded into the card came from that board.
`DEFAULT_SOURCES` (`indeed` + `himalayas`) is only the fallback for a caller that names none.

### JobSpy caveats worth knowing

- **No salary data at all.** Measured: 0 of 200 Poland postings from Indeed and LinkedIn had
  a salary, versus ~4 of 20 on Himalayas. That is why Himalayas stays in the default set.
- **Indeed is country-scoped.** It searches a national domain, so `location: "European Union"`
  returns zero. The country is derived from the location string
  (`"Berlin, Germany"` → `de.indeed.com`); for genuinely EU-wide search, add `linkedin`.
- **Boards block aggressively.** LinkedIn rate-limits around the 10th page from one IP, and
  every board caps a search at ~1000 results. HTTP 429 is handled as a skip.
- **LinkedIn is paged by the bridge, not by JobSpy.** JobSpy 1.1.82 moves its offset by the
  whole list collected so far (0, 10, 30, 60, 100…), so it read 60 of a query's first 200
  results; and on HTTP 429 it returns what it has without raising. `scripts/jobspy_fetch.py`
  asks for one page per call (`offset`), with JobSpy's 3–7 s pause, and watches JobSpy's error
  log. A pass cut short keeps its rows but is recorded as failed (`partial, N rows kept: …`),
  so the next incremental pass starts from the last complete one, after the 24 h backoff.
  The version is pinned in `setup:jobspy` because the bridge relies on how 1.1.82 treats
  `offset`.
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
| `GET /`                              | The page, src/dashboard.html (Поиск + Отклики)              |
| `GET /fonts.css`                     | Onest and Unbounded, read from `node_modules` at boot      |
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
| `POST /api/apply`                    | `{ key, fresh?, open? }` → «Подать»: whom to write to and the drafted note and letter; someone found opens in the browser, this computer only |
| `POST /api/verdict/open`             | `{ key }` → open that verdict's session in Claude Desktop; this computer only |
| `POST /api/verdicts/queue`           | Queue every shown card without a current verdict, as manual requests (202, `{ queued, status }`) |
| `POST /api/verdict/feedback`         | `{ key, expected }` → «Верно» / «Мимо» on a verdict |
| `GET /api/settings`                  | `{ claude, criteria, preferences }`: the Claude settings with today's background runs and the defaults, where the criteria stand, «Мои условия» |
| `POST /api/settings/claude`          | `{ auto, model, effort, daily, rejudge, soft, softenFactors }`, any of them → saved, then the queue re-checked; 400 on a bad value |
| `POST /api/settings/preferences`     | «Мои условия» and `rulesOff`, any of them → saved, the feed rebuilt; 400 on a bad value or an unknown rule |
| `GET` / `POST /api/criteria/check`   | The «Сверить» run: its state / start one (`{ set: "labels" \| "borderline" }`) |
| `POST /api/criteria/restore`         | `{ version }` → write an older criteria text back into the file |
| `GET /api/rules`                     | Настройки → Правила: each rule with its hits now, the freed cards, what the fit gate left out |
| `POST` / `DELETE /api/rules/override` | `{ key, reason }` → «правило ошиблось» on a card; `{ key }` → give it back to the rules |
| `GET /api/search-setup`              | Настройки → Поиск: the queries with their yield, the boards, the way from stored to shown |
| `GET /api/memory`                    | Настройки → Компании и память: blocked companies, hides that hide copies, the forgotten, the company boards |
| `POST` / `DELETE /api/memory/forget` | `{ kind: "company" \| "hide", key, label? }` → «вернуть» / «забыть»; DELETE takes it back |

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

### The page

[src/dashboard.html](src/dashboard.html) — plain HTML with its CSS and script inline, read
by the server at boot, which fills in `__STATUSES__` and `__SOURCES__`. It used to be a
template literal inside `dashboard.ts`, where a stray backtick or an unescaped backslash
blanked the whole page and `tsc` said nothing; restart the server after editing it.

The look, «Глубина» (chosen 2026-10-27, after "Солнце"): dark only — the light theme and
its switch went —, a near-black ground (`#07080D`) with one soft tangerine glow, layers of
white at a few percent instead of solid panels, one tangerine accent (`#FF7A45`) with dark
text on it (white on that orange would be 3.4:1), and two typefaces — **Unbounded** for the
few display lines, **Onest** for everything else, both with Cyrillic, served from
`node_modules` (`@fontsource-variable/*`) through `/fonts.css`. The colours are tokens at
the top of the stylesheet. The desktop window opens at 1280×720, and the page fits it.

It is laid out as an app window: the header across the top — the brand with ↻ and the
boards' age, the stacks in the middle (on Отклики, its statuses in the same place), my
links, Найти and the avatar on the right —, a rail down the left with the two sections and
Настройки at its foot, and the view taking exactly the rest; every column scrolls inside
itself. No scrollbar is drawn anywhere: a list that goes on fades out at its foot instead (a
mask moved by a scroll-driven animation, so the fade is gone at the end and when nothing
scrolls). No native select or checkbox is drawn: a select is a button whose options open in
one shared listbox, placed by the script so neither the tracker's table nor the settings
dialog clips it (arrows, Home/End, Enter, Esc); a checkbox keeps its real input under a
drawn box. Under 900 px the page scrolls as a whole and the columns stack.

On **Отклики** a click on a row opens that application in a drawer on the right: its status
(changeable there or in the row), when it went out and when the reply came, whom I wrote to,
what went with it, the company's other applications and postings, the posting's link. The
right column sums up: reply and silence rates, days to a reply, the last reply, this week.

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
| nofluffjobs, justjoin, workable, jobicy, djinni, dou, indeed, himalayas | a full month-wide pass every 6 h (`JOBHUNT_REFRESH_HOURS`), ~2–5 s each. ↻ Обновить runs it now |
| watchlist | daily, ~10 s for 16 boards |
| hackernews | daily, ~2 s: the latest "Who is hiring?" thread |
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

The page opens on **Поиск**, and it is not a grid: it is a stack you go through one posting
at a time — a strip of Claude's scores on the left, the posting in the middle with a dock of
four actions floating over its foot, and on the right what is known around the posting.

1. **The stacks** are Claude's verdicts: **Подходят**, **Проверить**, **Все** (everything
   Claude did not take away, unjudged ones included), **Почти подошли** (Claude's skips scored
   20 or more — all six disputable skips of the 2026-10-24 audit were among them) and **Убрал
   Claude** (every skip, those included). They sit in the middle of the header, each with its count; the strip's foot says where you are (`3 / 13`).
2. **The card** has the verdict and score, the title, company and place, the posting's age
   and board, a link to the posting on its board, and four facts — pay, work mode (quoted
   from the text), level, whether it can be done from Poland — then the role's stack as tags
   and, inside the card and kept quiet, Claude's read: the score's tile, one line with the
   verdict, model and age, the summary, short lists of what fits (+) and what is off (–),
   and the stop factors. Notes above the facts say what else is known about the posting:
   office days or Polish above B1 (B2, C1, "fluency", "biegle", "płynna", "swobodnie" — not
   when the sentence makes it a plus) in the text, a re-post, a rule hit, pay under the floor.
   **The right column** has the rest: the history with the company (my applications there,
   or the server's "откликался сюда" when it matched them through a copy; its other postings
   in the feed — a click opens one, «Все N вакансий компании» lists them in Найти), the copies
   dedupe folded into this card, by board, and what the rules did. The «Верно / Мимо» marks
   went on 2026-10-27; the ones made stay labels for «Сверка с эталоном».
3. **The dock**: **Скрыть** opens the reasons over it — Claude's own first for a skip —, one
   click hides; **В воронку** records an application (`applied`, there is no bookmark
   stage); **Обсудить** opens the verdict's session in Claude Desktop; **Подать** opens the
   posting in the browser and turns the middle of the page into the letter to a person (see
   *«Подать»* below). Keys, on purpose few (2026-10-27): `Enter` is **Подать**, `↑` `↓`
   walk the queue without deciding, `Esc` closes what is open — nothing else, and no key
   is drawn on the page. Enter on a focused button or link is that button's. «Потом» is
   gone: `↓` does the same without marking anything.
4. Every decision moves to the next undecided card, which slides in. A decided card keeps
   its tile in the strip for the rest of the page session, dimmed and named *подаю…*, *в
   воронке* or *скрыто*, so the queue shows progress instead of shrinking; the next search leaves out
   what is hidden or applied to. When a stack is done the card says so, with what happened
   and a button to the next stack.
5. Hidden means hidden from every search, here and in `find_jobs`; **Вернуть** on a hidden
   card (with *скрытые мной* on) brings it back.
6. **Фильтры** (the icon at the top of the strip) holds the rest: a text filter over the loaded postings, the date window, the
   boards, *прятать отклики*, *скрытые мной*, *скрытые правилами*, and the queue's order
   (Claude's score — the default —, profile match, newest, company). A dot on the button says
   a filter is on.
7. **↻** next to the brand asks the fast boards again; its own text says how fresh they are
   (`5 ч назад`), with every board's age in the tooltip. A badge on **Поиск** in the rail counts what is new
   since the tab was last opened, and so does the browser tab's title.

   **The rail** switches between **Поиск** and **Отклики**, with **Настройки** at its foot;
   the boards are narrowed under **Фильтры** only. The strip is always folded (2026-10-27:
   less to read): each tile is Claude's score itself, in the verdict's colour — green fits,
   amber check, grey skip — pulsing while Claude reads and a dash before; a short rule parts
   «Подходит» from the rest; the title shows on hover and is the tile's name for a screen
   reader. The queue goes best to worst by that score unless **Фильтры → Порядок** says
   otherwise. My LinkedIn, GitHub and portfolio links sit in the header: a click copies one,
   and its button turns into a tick with «… скопирован» under it. The avatar
   (`src/assets/avatar.jpg`, served at `/avatar.jpg`) opens Настройки.

   **Найти** (the magnifier in the header; Ctrl K is no longer a key) jumps anywhere: type
   part of a title or a company, `#` for a stack, `@` for a company's postings and
   applications; in the dialog `↑` `↓` and `Enter` pick, `Esc` closes. Opening a posting
   takes you to its own stack. **Right-click** on a tile (or the menu key) gives the card's
   actions for it — Подать, В воронку, Обсудить, Спросить Claude, Скрыть ▸ with the reasons,
   copy the link; an action opens the tile's card and runs on it, as its button would.
8. **The date window** (сутки / 3 дня / неделя / 2 недели / месяц) narrows by posting age.
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
   by that pass: a posting that will not say how old it is cannot be shown to be inside the
   window.

   One exception, in the month window only: an offer that a board read whole each pass —
   NoFluffJobs, justjoin.it, a company board (`PER_PASS_SOURCES`) — still listed on its last
   good pass is open, whatever its date (`listed` on the card; `inDateWindow` in pipeline.ts).
   justjoin.it offers the employer keeps renewing are 30–100 days old; counted from their
   first publication, 27 of them were cut on 2026-10-24, 17 remote React roles among them,
   and company boards publish no dates at all, so every watchlist role went 30 days after it
   was first seen. The narrower windows still mean "posted recently".
9. **The boards** — one checkbox per board in `SEARCH_DEFAULTS.sources`. They are a search
   parameter, so unticking one re-runs without it, and the server intersects the list with
   the profile's own: a hand-written URL can narrow the search but never make the dashboard
   scrape a board the profile never chose. At least one has to stay on.

   **LinkedIn is on by default and it is the slow one.** Measured on the same pass:
   `indeed + himalayas` takes ~3s, adding LinkedIn takes ~80s for ~900 extra postings.
   Unticking it is how you get a fast search back. See *What each board is worth* below.
10. A search returns up to `SEARCH_DEFAULTS.limit` (200) cards that are shown by default, all
   of them in the queue — one card is drawn at a time, so there is nothing to page through.
   Rule hits and jobs already applied to or hidden come on top of the 200, for their toggles:
   counted inside it, they took 87 places on 2026-10-24, and the 23 cards below the cut were
   neither shown nor judged by Claude. (The budget used to be 40.)

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

- **The verdict decides the stack** — **Подходят** (apply), **Проверить** (maybe: worth a
  look, something is unclear), **Убрал Claude** (skip) — and the card shows it: the verdict
  and score, Claude's summary, the stop factors with a quote from the posting, the doubts,
  what matches, and the pay / work mode / level / Poland facts it read. A dashed chip was
  judged under criteria that have changed since; the background queue redoes it (the card
  says so only where the queue will).
- **A skip is not hidden for good.** Nothing is written to the hidden list: it waits in
  **Убрал Claude**, and **Скрыть** there offers Claude's own reason first (taken from the
  page's one-click reasons, so it teaches the screening rules like a hand-picked one). A job
  already hidden or applied to stays out of the stacks whatever Claude said. **спросить
  заново** asks again; a card without a verdict says **Спросить Claude**.
- **Which stop factors remove a card is mine to say.** Each stop factor comes typed —
  format, Poland, citizenship, level, stack, role, language, closed. **Настройки → Claude →
  «Не убирать, если единственная причина — …»** ticks the kinds that alone do not take a card
  away (format, level, stack, role, language; Poland, citizenship and a closed posting always
  do): a skip whose every stop factor is a ticked kind reads «Проверить», with a note naming
  them. It is applied to the stored verdicts when the page asks for them — no run, no stale
  verdicts, unticking puts the cards back. Verdicts made before stop factors were typed stay
  skips.
- **Pay under the floor is a doubt, not a stop factor** — "maybe", score at most 55 — the
  same rule as the screening: such a card is flagged, never hidden, because some of those
  were applied to on purpose. The code reads a range as the criteria do (`payVsFloor` in
  boards-pl.ts): its top under the floor is `below` (red «Вилка», demoted, «Всё равно
  подать?»), the floor inside it with the middle under it is `midlow` (amber, a flag, nothing
  else). The prompt states the board's figures and that reading, in PLN a month B2B-equivalent;
  the card shows that figure too beside hourly, yearly and foreign ones.
- **Обсудить с Claude** opens that verdict's own conversation in Claude Desktop, with the
  posting and the verdict already in it — ask about the stack, the money, a cover letter. It
  is the deep link `claude --desktop --resume` uses (`claude://resume?session=<id>`;
  Desktop imports the CLI session and focuses it). Without Desktop, a console window runs
  `claude --resume` with no tools. This computer only: that is where the window opens.
  Before it opens, the server writes `~/.job-hunt/verdicts/CLAUDE.md` with the whole of
  `profile.json` in it, so a question from an application form is answered from the
  profile (pay as net B2B or gross UoP, notice, work permit, the answer bank) and not
  guessed from the criteria's thresholds. The criteria name the profile by its path in
  this repo, which the sessions' folder cannot resolve. The CV goes in too, as text read
  from the PDF at `cvPath` (the one the forms upload, so an edit in OneDrive shows up on
  the next open): open questions — "the most complex app you worked on", "a hard frontend
  problem" — are answered from its projects and numbers, not from the profile's one-line
  job summaries. Verdict runs are `--safe-mode` and never read that file; a resumed
  session, old ones included, does.
- **лучшие по Claude**, the queue's default order (Фильтры → Порядок), sorts by verdict, then
  score; the profile's ranking breaks ties. The line
  next to the stacks says what the verdict queue is doing (`Claude оценивает 2, ждут 30`, or
  why it is paused).
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
  first, at most the daily cap from **Настройки → Claude** (80) **runs** a day, redone and failed ones
  included. A queued card that gets hidden or applied to leaves the queue.
- **What stops the whole queue stops it, not a posting**: the plan's limit (Claude Code
  2.1.287 says `You've hit your session limit · resets 11pm` with `api_error_status` 429 —
  the queue sleeps until then), a lost login, a missing `claude`, an unreadable criteria
  file. The card that was running waits in the queue, and the line above the cards says
  why. A failure of the posting itself (no text, a timeout) is tried once more half an
  hour later; the card says what went wrong.
- **Stored per job** in the `verdicts` table, with the version of the criteria it was made
  under, the model, the session id, how much text Claude read and how long it took. The text
  itself goes to `posting_texts`: for LinkedIn, NoFluffJobs and justjoin.it it is the only copy
  (their listings carry none), and Claude Code deletes its session files after 30 days. A
  background re-judge within three days of a read reuses it instead of reading the page again
  — a criteria edit re-judges every shown card; a card asked for by hand always reads the page.
  The labelled sets for checking the verdicts (the 28 postings of the 2026-10-23 calibration,
  the 2026-10-24 audit of all shown cards) are in `~/.job-hunt/eval/`.
- **The criteria file is the thing to edit**: who I am, what I want, the stop factors, the
  fine print ("no salary in the text is normal — do not lower the verdict for it"). It is
  re-read on change, and every verdict made under the old text goes stale. What the
  background then redoes is **Настройки → Claude → «После правки критериев»**: every shown
  card, only «Подходят» and «Проверить», or nothing (new postings only; «Оценить оставшиеся
  сейчас» redoes the rest by hand, past the cap). Redoing never takes the last quarter of the
  daily cap — that stays for postings appearing later the same day; on 2026-10-24 two edits
  used 193 of 200 runs. The same section says how many shown cards are judged under older
  criteria and how long redoing them would take, and keeps every version's text
  (`criteria_versions`): «что изменилось» shows the lines an edit removed and added,
  «вернуть этот текст» writes an older one back into the file.
  The facts in it mirror `.claude/skills/job-apply/profile.json`; change both.
- **Checking criteria before they re-judge everything** ([src/verdict-eval.ts](src/verdict-eval.ts)).
  Claude's verdict on each card carried **«Верно» / «Мимо»** until 2026-10-27; «Мимо» asked
  which verdict it should have been (`verdict_feedback`, still read, no longer written by the page). Every hide, restore and «В воронку» is also kept with
  the verdict it answered (`decisions`). From these — and the 28 postings decided by hand for
  the 2026-10-23 calibration — comes a set of postings whose right answer is known: a mark is
  the verdict itself; a hide with a reason the text carries (не remote, не тот стек, …) means
  "skip"; an application means "not skip"; hides for reasons outside the text (applied
  elsewhere, the company, pay — a "maybe" by design) are no labels. **Настройки → Claude →
  «Сверить с твоими решениями»** runs the current criteria on that set from the saved texts,
  two at a time, outside the daily cap, nothing overwritten, and lists where Claude and the
  label differ; «Пересчитать пограничные» runs the current verdicts scored 20–70 again — the
  ones an edit tends to flip. A draft is checked before it goes into the file:
  `npm run eval:verdicts -- --criteria draft.md` (`--set borderline`, `--limit N`); every run is
  saved under `~/.job-hunt/eval/runs/`. A good routine for an edit: «После правки критериев:
  ничего», edit, check, then «Оценить оставшиеся сейчас». The criteria of 2026-10-24 evening
  agreed with the calibration on 22 of 28 (the first criteria: 20); of the six misses, four
  were hidden for reasons outside the text. With the DevOps/architecture and «ты» edits: 24.
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
| `TARGET_QUERIES` | The searches the Refresh button runs. Fourteen since 2026-10-30: "product engineer", "ui engineer", and two AI ones that name TypeScript ("ai engineer typescript", "llm typescript") so the boards return LLM work in my stack. Many, because no single keyword covers everything a frontend role gets titled — the same job is "Frontend Developer" at one company and "Web Engineer" at the next. Each line's measured marginal yield is in the comment above it; order is not a ranking signal |
| **The emphasis** | Currently **frontend**, with AI/LLM as a bonus rather than a target. Frontend terms carry the highest weights, fullstack counts less, and a backend-titled role is penalised. Shift it by editing the weights |
| `SEARCH_DEFAULTS` | Location, remote-only, how far back to look, which boards, how many results, and `maxFitTier` |
| «Мои условия» (Настройки) | The pay floor, the UoP↔B2B equivalence, hours a month, the giants whose office roles in the named city are fine, my Polish level — read by the rules and written into Claude's criteria |
| `SEARCH_DEFAULTS.sources` | Which boards to query — and, one-for-one, the boards the Search tab's filters offer. The filter can only narrow this list |
| `STACK_WEIGHTS` | What counts as a good match. Taken from the CV; title matches count double, and available posting descriptions supply additional evidence |
| `FOREIGN_STACK` | What sinks a posting: .NET, Java, Angular, ML/data-science, backend-only titles, plus non-engineering roles like recruiter or designer. A title match counts triple |
| `JUNIOR_MARKERS` / `SENIOR_MARKERS` | Seniority detection, English and Polish |

Nothing else in the codebase encodes any of it.

The **Отклики** tab opens on a headline ("91 отклик, 21 ответ" and how quickly replies
come), six figures, and a bar of where the applications stand — waiting, in talks, offer,
rejected, silent, dropped. Below, the list: each row carries one status control — the
coloured dropdown *is* the status display, in words ("ждём ответа", "тишина") — and no
notes column: notes are still stored and still written by `add_note`, they are just not
what the list is for. The pills above it filter by status, with one grouped shortcut:

- **В работе** — still alive: `applied`, `responded`, `screening`, `interview`

No single status answers that, which is why it is its own pill.

## Tests

```bash
npm test          # everything: typecheck, scorer checks, MCP, dashboard UI
npm run sanity    # eligibility + stack-fit scoring (fast, offline)
npm run test:mcp  # drives the real MCP server over stdio
npm run test:ui   # runs the real dashboard page JS against a real server
npm run eval:verdicts  # Claude's verdicts against the known answers (real claude -p runs; see above)
```

`test:mcp` and `test:ui` each spawn their own process against a throwaway database in the
temp directory — they never touch your real one. Both hit live job boards, so they need
network and take a few seconds. `test:ui` uses port 4399 and refuses to run if something else
holds it, rather than testing the wrong server (`TEST_PORT` overrides).

**`test:ui` earns its keep.** It evaluates the script of [src/dashboard.html](src/dashboard.html)
as the server serves it — placeholders filled in — and drives the stacks, the card's
actions, its two keys, the letter and the tracker with its drawer through it against a minimal DOM shim; `tsc` sees none
of that page. It caught a syntax error twice when the page was still a template literal,
a bug where optional arguments silently overwrote the search profile, and a placeholder
left unfilled because the page's own comment named it first. Run it after touching the page.

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
  dashboard.ts    node:http server on :4321
  dashboard.html  the page: Поиск (one posting at a time) + Отклики
  verdict.ts      Claude's verdict on a posting: `claude -p`, the queue, "обсудить в Claude"
  verdict-criteria.md  WHAT I WANT, in words: the brief Claude judges postings by. Edit this
  verdict-eval.ts the criteria against postings whose right answer is known («Сверить»)
  preferences.ts  «Мои условия»: the floor, the offices, Polish, rules off, the memory window
  screening.ts    my screening rules: titles, Polish, age, the memory of my hides
  screen-context.ts  the screening context as the database has it (funnel, hides, Настройки)
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
  then fit band and seniority; then postings whose text asks for office days (except a
  giant's Warsaw office, `OFFICE_OK`) or fluent Polish; then eligibility confidence and recency. A junior title or a foreign stack in the
  title is tier 3 outright — a body full of React cannot lift it. An AI title with no
  frontend/fullstack/web in it is capped at tier 1, after the frontend roles. A title that
  names no level falls back to the board's own (Himalayas tags, nofluffjobs / justjoin.it
  levels): Senior ranks as senior, Mid-level/Entry-level just below "unstated".
- **`minSalary`** (find_jobs) is PLN per month, B2B-equivalent, in the same unit as the floor
  — it used to compare monthly and foreign figures with an annual number.
- **Screening rules run inside the search** ([src/screening.ts](src/screening.ts), lists in
  profile.ts): the same rules as `funnel.mjs screen`, applied at read time against the funnel
  and the hidden list. Hits stay out of the stacks unless *скрытые правилами* is on (Фильтры), with their reason;
  nothing is written to `dismissed`. Hides written by a rule never count as evidence. The same
  role already applied to through another board (same company, same title once tags like
  "(m/f/d)" are gone, applied in the last 60 days — `REAPPLY_AFTER_DAYS`) is a rule hit; a
  role that is only similar is a flag on the card, not a hide. "скрыть ▾" takes a
  one-click reason; "не интересна компания" hides that company everywhere.
- **Настройки → Правила** lists every rule that hides a card for what the posting says —
  the title rules, Polish above my level, backend-only, older than 60 days, Indeed's
  onsite/hybrid — with its words, how many cards it hides in the feed right now and a few of
  them by name, and a switch. A rule switched off stops hiding from the next request (stored
  as `rulesOff` with «Мои условия»); the list still says what it would hide again. The same
  switches are how AI-only titles or PHP stop being hidden — no code change. On a card a rule
  hid, the reason carries **«правило ошиблось»** (the right-click menu too): that card meets
  no hiding rule again, memory rules included, and goes to the stacks and Claude's queue — an
  application still keeps it out. Such cards are kept in `rule_overrides`, listed in the panel
  with «вернуть правилам», and every one is in `decisions` as `rule-wrong` against its rule.
  Under them, read-only, what the fit gate left out before any rule ran — junior titles, a
  foreign stack in the title (with the term), a foreign stack outweighing the target one in
  the text — counted over the month with examples. `funnel.mjs screen` takes the dashboard's
  decision when the search sends one, so the switches and freed cards hold there too.
  The AI and QA exceptions ("AI" or "automation" in a frontend title is not an AI or QA
  role) now read the normalised title: "Full-Stack AI Engineer" used to go as an AI role.
  The mid-level rule passes a range that reaches senior ("Middle/Senior", "Regular/Senior",
  "Sr. Software Engineer II") and a version ("Developer 2.0") — 6 of its 12 hits on
  2026-10-24 were such — and catches a bare "Mid". The mobile rule passes "mobile" as one
  platform beside web or desktop ("React / Electron Developer (Web + Mobile + Desktop)")
  unless the title names a native stack.
- **The soft lane.** Fit tier 2 — no stack recognised either way — is mostly LinkedIn,
  nofluffjobs and justjoin.it, which store no text: every title that names no stack,
  "Senior Software Engineer" at Asana or Sezzle. Those used to be dropped unread. Now an
  engineering title, open to Poland for sure, that no rule removes is read by Claude in the
  background, after the shown cards and within a quarter of the daily cap (Настройки → Claude
  → «Дочитывать общие заголовки»); it shows only when Claude says apply or maybe, with a note
  that it came this way. A criteria edit re-judges only those that fit last time.
  Company boards (watchlist) keep such roles too instead of dropping them on fetch.
- **What hides teach** is checked after what the posting itself says, so a card shows the
  concrete reason when there is one. "Same role hidden earlier" needs the same title once
  tags are gone, or at least three words naming the role on both sides, more than half of
  them shared, and the same level — compared on one or two words it hid other teams' roles
  and, with the level words stripped, a hidden mid-level opening hid the senior one; two
  titles that name no role ("Senior Software Engineer") are never one. A company is blocked
  without an explicit reason only after two different *frontend or fullstack* roles there
  were hidden with none, and never a WATCHLIST company or an OFFICE_OK giant. The card says
  which hides and when: «same role hidden earlier (07.09, без причины): …». On the
  2026-10-24 data: 14 blocked companies instead of 30, 2 same-role hits instead of 26.
- **Настройки → Компании и память** shows that memory and lets me correct it: the blocked
  companies (said by me, or the two hides with their dates) and the hides that hide a copy of
  their role right now, each with how many cards it stands behind. **вернуть** gives a
  company back, **забыть** stops a hide from teaching — the posting itself stays hidden;
  both go to `memory_forget` and are listed under «Забытое» with **вспомнить**. **Помнить мои
  скрытия** (`memoryDays` in «Мои условия»: always, 30 days … a year) lets old hides lapse;
  «не интересна компания» is a choice, not evidence, and stays. Below, the company boards I
  read (WATCHLIST): for each, how many roles are stored, still open on the board, shown in the
  stacks, judged apply or maybe by Claude, and how many applications went there — a board
  that never brings anything is easy to spot. The dashboard and find_jobs build this context
  from the database in one place, [src/screen-context.ts](src/screen-context.ts).
- **Настройки → Поиск** is read only: what is searched and what comes of it. The way from
  the stored postings to the screen, step by step (stored → without cross-board copies → in
  the window → open to Poland → by stack, plus the titles without a stack Claude reads → minus
  my hides, the rules, the applications → on screen, with Claude's split); each query with
  how many postings it found, how many no other query found, how many are on screen, judged
  fit by Claude, applied to; each board with its shelf, what it puts on screen and when it was
  last read. Which query found a posting is recorded from 2026-10-24 on (`posting_queries`,
  filled by the refresh; `foundBy` on a fetched job, never stored with the posting) — the
  query table in profile.ts was trimmed by measured marginal yield once, and this keeps the
  measurement running. Queries and boards are still edited in src/profile.ts.
- **Фильтры survive a reload**: the date window, the boards switched off, the three toggles
  and the order are kept in the browser (`localStorage`, per browser — the text search is
  not). A stored value the page no longer offers is ignored, and a board added to the profile
  later starts on.
- **Stack keywords come from the CV**, weighted, in `sources.ts`. That list is the single
  place that encodes "what I actually do" — edit it to change what ranks highly.

## Applying by script

Three skills under `.claude/skills/` drive the whole pass without the browser
extension: **job-screen** (rules and the reading of each posting), **job-apply**
(one application), **job-pipeline** (the whole pass). They decide from Claude's
verdict first, hide nothing but closed postings, and send nothing the user has
not seen in a dry run. They are thin wrappers over four scripts:

| Script | Does |
| --- | --- |
| `scripts/funnel.mjs` | CLI over the dashboard API: `search`, `screen [--commit]`, `dismiss`, `undismiss`, `add`, `applied`, `dismissed`, `stats`, `status`. `screen` writes nothing — the dashboard applies the rules on every read; `--commit` would make the hits permanent hides, written as `auto: <reason>` so they never count as the user's own |
| `scripts/jobs-fetch.mjs` | Reads postings without a browser (board JSON APIs, LinkedIn guest API, stripped HTML, Chrome only for JS-only pages) and prints one line per job: work mode, stack, level, language/country constraints, ATS, form questions |
| `scripts/apply.mjs` | Fills and submits one application with Playwright on the installed Chrome; records it via `POST /api/applications`; exit codes for missing answers, account walls, CAPTCHAs, e-mailed verification codes |
| `scripts/apply-batch.mjs` | Runs `apply.mjs` over a list, one result line per job. Dry runs unless `--submit`; no current Claude `apply`, pay under the floor or a role like one applied to is skipped with the reason (`--force` / `--accept-low-pay` per index); it passes `--pay`, `--contract` and `--office-ok` |

**«Подать» in the dashboard fills no forms** (since 2026-10-26, at my request: the
filled forms did not work out, and 112 cold applications had brought 0 interviews). It
opens the posting in the browser at once — in the click, so no popup blocker stops it —
and I apply there myself. Meanwhile the server (`POST /api/apply`,
[src/outreach.ts](src/outreach.ts)) finds whom to write to and drafts two texts, ~10–20 s:

- **Whom**, best first: an e-mail the posting gives for applications or questions
  (`jobs@`, `careers@`, or an address next to "send your CV"; privacy and no-reply boxes
  never) → Gmail's compose window, addressed and written, opened at once — attach the CV
  and send; a person the posting names (a recruiter, "osoba kontaktowa"), word for word in
  its text → LinkedIn's people search for them at the company, opened at once; a LinkedIn
  posting → its own page, already open, where "Meet the hiring team" sits when the poster
  filled it in; otherwise LinkedIn's search for the company's recruiters, opened at once
  too (since 2026-10-27: before, nothing of LinkedIn opened for most postings, which name
  no one) — the letter says it is a search, not someone found. LinkedIn is never read with the login: its guest pages carry no hiring team
  (probed 2026-10-26), and a scripted logged-in session puts the account at risk.
- **What**: a note for a LinkedIn connection request (200 characters, a free account's
  limit; the letter counts) and a 3–4 sentence letter whose signature code types, both by
  the same headless `claude -p` as the verdicts — no tools, the posting marked as the
  employer's text, facts from the CV and profile.json only. If Claude cannot answer, a
  template stands in and the letter says why. Both are editable; «скопировать» copies one;
  «Переписать» asks Claude again. A job's texts are kept until the server restarts.

All of it fills the middle of the page in place of the card: the posting in one line, then
«Письмо человеку» — whom to write to, said plainly (a search is a search, not a person
found), the note and the letter. The dock becomes the letter's — «Назад к вакансии», «Не
подаю, скрыть» (back on the card with the reasons open), «Отправил, в отклики» — and the
right column shows the three steps. «Отправил, в отклики» records the application; with
«Человеку написано» ticked (copying a text ticks it) its notes say whom I wrote to
(`outreach: <kind> <label>`), so replies can later be compared with and without a note.
Published pay under the floor is a warning in the letter. The card's tile stays marked
*подаю…* until recorded; going back to the card clears the mark.

**A board's posting is not the employer's form**, and `apply.mjs` asks the board first.
justjoin.it renders each offer's `applyUrl` into its page: the employer's form (traffit,
recruitee, Greenhouse, Gem…; 65 of 86 stored offers on 2026-10-24), which is then filled
like any other, short links followed so Greenhouse is still recognised; `null` means
justjoin's own form. NoFluffJobs gates both its own form and its redirect to the
employer's behind a CAPTCHA, and Himalayas hides the employer's link behind Cloudflare.
Those, and a justjoin offer without a link, come back at once as `board-form`
(«только через площадку») with the posting to open, without starting Chrome; a removed
offer comes back as `closed`. Before this, a justjoin card was "dry run" on the board's own
page, with zero fields filled and «Отправить отклик» offered anyway. A dry run that fills
nothing is now `no-form`, and the server refuses to submit one.

**Salary fields ask for the posting's top when it beats the target.** `apply-batch.mjs` passes the
posting's published ranges (`--pay`); where the top of a range on the field's contract and
in its currency is above profile.json's figure, the field gets that top instead — cerebre
published B2B 5.8k–8.3k USD and its form used to get $7,000, now $8,300 (≈ $100k / year).
Hourly, daily and yearly ranges are converted to a month; a range with no contract
(Himalayas) counts as B2B; another currency is never converted. A lower range, or none,
leaves the answers exactly as they were. The «Обсудить» brief carries the same rule.

Facts the forms ask for live in `.claude/skills/job-apply/profile.json`. Chrome
profiles: `~/.job-hunt/chrome-profile` (LinkedIn, log in once with
`node scripts/apply.mjs --login`) and `~/.job-hunt/chrome-profile-ats` (all
other boards). The scripts never create accounts, never type passwords, never
solve CAPTCHAs and never read verification codes from the mailbox — those
steps are handed back to you.
