---
name: job-pipeline
description: End-to-end job application run over the Job Hunt Search tab — screen the results, hide the unfit, read every remaining posting without a browser, apply through each ATS by script, record every application in the funnel, and report what needs the user. Use when asked to "apply to everything that fits", process the search, or run the daily job-hunt pass. Needs the dashboard at http://localhost:4321 and Chrome.
---

# job-pipeline — the whole pass, cheaply

Five commands, five short tables. Nothing is read through the Chrome
extension; postings are fetched by script and forms are filled by script.
Budget: one output line per job per stage.

## 0. Preconditions

- Dashboard running (`Job Hunt.bat` or `npm run dashboard`), Search refreshed
  today (`node scripts/funnel.mjs search --refresh` if the cache is stale).
- LinkedIn Easy Apply wanted → the automation profile is logged in
  (`node scripts/apply.mjs --login`, once).
- Scratch directory for this run: `$TEMP/claude/` (or the session scratchpad).

## 1. Screen (rules) — `job-screen`

```
node scripts/funnel.mjs screen --json $S/screen.json        # dry run, read the DISMISS bucket
node scripts/funnel.mjs screen --commit                     # hide them, with reasons
```

## 2. Read the postings — no browser

```
node scripts/jobs-fetch.mjs --screen $S/screen.json --buckets apply,check --out $S/fetched.json
node scripts/jobs-fetch.mjs --retry $S/fetched.json          # re-fetch the rows that errored (LinkedIn 429)
```

One line per job: `idx | company — title | mode | lock | level/years | +stack | -neg | lang | $salary | apply:<vendor> form:…`.
Decide from the line, and only open the text (`--text`, or `text` in the JSON)
when the line is ambiguous:

- `hybrid …«context»` / `onsite` → hide: `not remote (hybrid N days/week)`.
  Exception: "1 day a week, preferably" in the user's city → **needs-you**, not hidden.
- `-angular/-vue/-.net/-php×N` dominating `+stack` → hide: `wrong stack: X`.
- `lang:german/polish` → hide unless the posting says "nice to have".
- `lock:US/UK` → hide: `remote but X-only`.
- `CLOSED` → hide: `posting closed`.
- `apply:portal` / `himalayas-account` / `indeed` → **needs-you** (account needed).
- otherwise → apply.

Hide with `node scripts/funnel.mjs dismiss "<url>" --reason ".." --title ".." --company ".."`.

## 3. Apply — `job-apply`

Split the survivors into two JSON lists (`batch-ats.json`, `batch-linkedin.json`)
and run them with `apply-batch.mjs`. Boards that e-mail a verification code
(Greenhouse) run headed and need the user at the keyboard, so run those last
and say so.

```
node scripts/apply-batch.mjs --fetched $S/batch-ats.json --out $S/results-ats.json [--answers $S/answers]
node scripts/apply-batch.mjs --fetched $S/batch-linkedin.json --out $S/results-linkedin.json
```

Then clear the `missing-answers` rows: write `$S/answers/<idx>.json`, re-run
with `--only`. A label that will recur goes into the answer bank once:
`node scripts/apply.mjs --remember "<label substring>" "<answer>"`.

Every `applied` row is already in the funnel (the script posts it). Do not
add it again by hand.

## 4. Close the loop

- Second posting of a role you just applied to (same company, other board):
  `dismiss … --reason "applied via <board>"`.
- `node scripts/funnel.mjs stats` and `applied | head` to confirm the count.

## 5. Report to the user

Four lists, one line each, nothing else:

1. **Applied** — company, title, board, funnel id.
2. **Needs you** — `node scripts/funnel.mjs attempts` (codes not typed, CAPTCHAs, account walls, missing answers — recorded by apply.mjs, also on the dashboard), plus hybrid-light roles and marketplaces (lemon.io, Jobgether, Proxify…) from the screen, with the URL.
3. **Hidden** — the count, grouped by reason (not the list; it is in the dashboard under "показать скрытые").
4. **Failed** — `submit-failed` rows with the error text and screenshot path.

## Cost rules

- Never `get_page_text` or screenshot a job page through the extension; `jobs-fetch` has the text.
- Look at a screenshot only for a `submit-failed`, once per board.
- Keep the whole run's model output under ~10 lines per job.
