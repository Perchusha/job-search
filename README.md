# job-hunt

A local job-search assistant: it pulls remote developer jobs from a dozen boards, drops
the ones you can't actually apply to, has Claude read every remaining posting and say
whether it fits, and tracks what happened to each application.

I built it for my own search — a senior React / TypeScript engineer looking for remote
work from Poland — so the defaults, the boards and the dashboard's language (Russian)
follow from that. Everything runs on your machine: one SQLite file, no accounts, no cloud,
no API keys.

## What it does

- **Collects postings** from Polish IT boards (NoFluffJobs, justjoin.it), company career
  pages on Greenhouse, Lever, Ashby, Workable, SmartRecruiters and Recruitee, Himalayas,
  Jobicy, Workable search, Hacker News "Who is hiring", DOU, and — through the optional
  [JobSpy](https://github.com/speedyapply/JobSpy) scraper — Indeed and LinkedIn. A refresh
  runs in the background every few hours.
- **Checks eligibility** before you see anything: can this role be done from Poland
  (remote vs. "US only", office days, EU-citizens-only), is the level and stack right,
  is the published pay above your floor. Each rule is plain code you can read and change.
- **Asks Claude about each posting.** Headless Claude Code (`claude -p`) reads the full
  text against a criteria file you write in your own words and returns a verdict — apply,
  check, or skip — with the stop factors quoted from the posting. It runs on the Claude
  subscription already logged in on the machine, so nothing is billed per call.
- **Shows one posting at a time** in a local dashboard, sorted into stacks by that verdict,
  with keyboard shortcuts and hide reasons that teach the filters.
- **Tracks applications** through a funnel (applied → responded → interview → offer, or
  rejected / dropped / ghosted) with notes and stats.
- **Talks to AI assistants** as an MCP server with 8 tools (`find_jobs`, `log_found_jobs`,
  `update_status`, `get_stats`, …), so "find me jobs and add the good ones to my funnel"
  works from Claude Desktop, Claude Code or Cursor.
- **Optionally fills application forms** with Playwright (`scripts/apply.mjs`); the batch
  runner dry-runs unless told `--submit`.

There is also a small Electron tray app for Windows that keeps the server running, starts
with the system and notifies you about new postings.

## Getting started

You need **Node.js 20+**. Optional: **Python 3.10+** for the Indeed / LinkedIn scraper,
and **[Claude Code](https://claude.com/claude-code)** logged in for the verdicts.
After switching Node versions the SQLite module rebuilds itself on the first start.

```bash
git clone https://github.com/Perchusha/job-search.git
cd job-search
npm install
npm run setup:jobspy        # optional; setup:jobspy:unix on macOS / Linux
```

Then make it yours. Your personal files are gitignored; each has a template beside it:

| File | What goes in it |
| --- | --- |
| `.claude/skills/job-apply/profile.json` | Facts application forms ask for: name, contacts, CV path, salary asks, notice period, work authorisation. Copy from `profile.example.json` |
| `.claude/skills/job-apply/profile.md` | The same in prose, for the Claude skills. Copy from `profile.example.md` |
| `src/verdict-criteria.md` | What you want and what rules a posting out, in your words — the brief Claude judges by. Created from `verdict-criteria.example.md` on first run |
| `src/assets/avatar.jpg` | Your picture in the header (optional) |

What to search for — queries, stack weights, the company watchlist, which boards — lives
in [src/profile.ts](src/profile.ts). The pay floor, the companies whose office roles are
fine and your Polish level are set in the dashboard under **Настройки → Мои условия**.

```bash
npm run dashboard   # http://localhost:4321
npm run refresh     # fetch the boards that are due now
npm test            # typecheck, scoring checks, MCP and dashboard tests
```

On Windows you can also double-click `Job Hunt.bat`, or build the tray app in
[desktop/](desktop/).

### Use it from an AI assistant

```bash
claude mcp add job-hunt -- npx tsx /absolute/path/to/job-search/src/index.ts
```

For Claude Desktop and Cursor, see [the guide](docs/GUIDE.md#connect-an-mcp-client).

## How it's put together

TypeScript on Node, run directly with `tsx` — no build step. Both the dashboard and the
MCP server go through one search pipeline, and both read the same SQLite file.

```
src/
  profile.ts         what to search for: queries, stack weights, boards, watchlist
  sources.ts         fetch and normalise every source, dedupe
  boards-*.ts        the board adapters; watchlist.ts for company career pages
  eligibility.ts     "can I apply to this from Poland?"
  screening.ts       title, language and age rules, and what your hides teach
  pipeline.ts        fetch → dedupe → score → filter → rank
  verdict.ts         Claude's verdict: the queue, the prompt, the schema
  dashboard.ts/.html the local web app
  index.ts           the MCP server
  db.ts              SQLite schema and queries
scripts/             form filling (Playwright), posting reader, funnel CLI
desktop/             Electron tray app
.claude/skills/      Claude Code skills that screen, apply and run the daily pass
```

## Limitations

- Built for one person's situation: living in Poland, remote-only, senior frontend /
  full-stack. The rules are easy to change, but they start out opinionated.
- The dashboard's interface is in Russian.
- Developed and used on Windows; the server and tests should run anywhere Node does,
  the tray app and launcher are Windows-only.
- Board adapters read public pages and feeds and break when a site changes its markup.

## More

[docs/GUIDE.md](docs/GUIDE.md) is the long version: every source and what it is worth,
the scoring tables, the data model and API, how the Claude verdicts are queued and
checked, and the gotchas found along the way.
