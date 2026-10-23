---
name: job-screen
description: Sort the Job Hunt search results into apply / check / dismiss buckets and hide the unfit ones in the dashboard. Use when asked to screen, triage or clean up the Search tab, hide unsuitable vacancies, or build a shortlist before applying. Needs the dashboard running at http://localhost:4321.
---

# job-screen — triage the Search tab

Goal: every card on the Search tab is either worth applying to, or hidden with a
reason. The deterministic part is a script; the judgement part is you.

## 1. Run the rules

```
node scripts/funnel.mjs screen --json <scratchpad>/screen.json
```

Dry run. It prints five buckets, one line per job: `index source match/fit geo
age company — title [location] {salary} <reason> url`.

| Bucket | Meaning | What you do |
| --- | --- | --- |
| `apply` | geo confirmed (Indeed says remote, or Himalayas open to Poland) and nothing in the title disqualifies it | hand to `job-apply` |
| `check` | LinkedIn rows: location unknown or "onsite/hybrid" — LinkedIn omits `is_remote`, so this is unverified, not a rejection | open the posting, decide (step 3) |
| `needs-you` | marketplaces that need an account (lemon.io, Jobgether, GitStart, Proxify, Alignerr…) — accounts are never created by the skill | list for the user |
| `dismiss` | rule hit: junior/mid, management, wrong stack, backend-only, another language, onsite per Indeed, stale, duplicate of a tracked application, same role hidden before, company hidden 2×+ and never applied to, second posting of a role already in this search | review, then commit |
| `skip` | already in the funnel or already hidden | nothing |

The rules live in `TITLE_RULES`, `FRONTEND`, `BACKEND_ONLY` and `decide()` in
[scripts/funnel.mjs](../../../scripts/funnel.mjs). Edit them there, not in prose.

## 2. Review the dismiss bucket, then commit

Skim the `dismiss` lines for a reason that is wrong for this title (the rules
are whole-word regexes on the title; a title like "Full Stack Engineer
(Node.js, Preact)" has been mis-filed before). Fix the rule, re-run, then:

```
node scripts/funnel.mjs screen --commit
```

Every hidden job carries its reason, visible under "показать скрытые" in the
dashboard and in `node scripts/funnel.mjs dismissed`. A mistake is one
`node scripts/funnel.mjs undismiss <url>` away.

## 3. Decide the `check` bucket — without a browser

```
node scripts/jobs-fetch.mjs --screen <scratchpad>/screen.json --buckets apply,check --out <scratchpad>/fetched.json
node scripts/jobs-fetch.mjs --retry <scratchpad>/fetched.json      # LinkedIn answers 429 — re-fetch the errors
```

One line per posting, read from the board's own JSON (LinkedIn guest API,
Greenhouse, Lever, Ashby, SmartRecruiters, Recruitee, Himalayas search API)
or from the stripped HTML:

`idx | company — title | mode «context» | lock:US | senior/8y | +react,typescript | -angular×2 | lang:german | $salary | apply:<vendor> form:3req "…"`

Decide from the line, in this order:

1. **mode** `hybrid «…»` / `onsite` → hide: `not remote (hybrid N days/week)`.
   `remote?hybrid` means both words appear — read the 70-char context; "remote
   or hybrid, your choice" is remote. "1 day a week, preferably" in Warsaw is
   the user's call: put it on the needs-you list, do not hide it.
2. **-neg** dominating **+stack** (`-angular×4`, `-python×15`, `-php×4`) → hide: `wrong stack: <x>`.
3. **lang** `german|french|italian|polish` → hide: `requires <language>` (B1 Polish is not "fluent Polish").
4. **lock** `US|UK|Canada|Germany` → hide: `remote but <country>-only`.
5. `CLOSED` → hide: `posting closed`. `ERR` → `--retry`, then decide.
6. **apply:** `portal` (Workday, Cognizant, EPAM, Luxoft), `himalayas-account`,
   `indeed` → cannot be scripted (account) → needs-you list, not hidden.
7. Otherwise it is an `apply` row for `job-apply`.

When the line is ambiguous, print the text of that one job
(`python -c` over `fetched.json`, or `--text` for a single URL) — never the
whole set.

Hide with:

```
node scripts/funnel.mjs dismiss "<url>" --reason "<reason>" --title "<title>" --company "<company>"
```

Hidden means hidden from every future search and from `find_jobs`, so the
reason must be true for the role, not for today's mood.

## Don'ts

- Do not hide a job only because the company rejected a *different* role
  before; do hide it when the same role is already tracked (the script does).
- Do not hide `needs-you` rows — the user may want to apply by hand.
- Do not widen the search here (sources, hoursOld); that is profile.ts.
