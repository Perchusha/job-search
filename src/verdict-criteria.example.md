# The criteria Claude judges a posting by

This is a template. On the first run it is copied to src/verdict-criteria.md (that file is
in .gitignore: it holds your personal facts), so edit that one. Any language will do:
Claude writes its verdicts in the interface's language whatever this file is in.

The whole file goes into the verdict's system prompt (src/verdict.ts). Edit it in your own
words: after an edit the old verdicts are marked "under old criteria" and redone as
"After a criteria edit" says. The pay floor, the giants whose office is fine and your Polish
level are set in Settings → "My terms": they are added at the end as the section
"Terms from Settings", so do not repeat them here. The facts for application forms live in
`.claude/skills/job-apply/profile.json`.

## The candidate

<Name>, Senior Software Engineer, N years of commercial experience.

- Stack and years: React N years, TypeScript N, Node.js N, …
- Now: <role> at <company>: what you do, what you are proud of.
- Before that: <role> at <company> (years), the main thing you did.
- Where you live and where you can work: for example, Poland, with a work permit for Poland
  only; other EU countries need relocation and sponsorship. Whether you would move.
- Languages: English C1, Polish B1, …

## What they want

- **Format.** For example: fully remote work from Poland only; occasional trips to team
  meetings are fine; hybrid and office are not.
- **The exception: the giants** in "Terms from Settings" at the end: hybrid and office are
  fine there if the office is in the city named there.
- **Level.** For example: Senior, Lead, Staff or Principal, hands-on. Mid, Regular, Junior
  are not.
- **Role and stack.** For example: frontend or fullstack on React / Next.js / TypeScript;
  backend on Node.js is good, backend in another language is not.
- **Money:** the floor is in "Terms from Settings" at the end.
- Contract type: what you prefer and what is also fine.

## Stop factors: any one of them makes it a "skip"

- Hybrid or office: required office days, "on-site", "office-based", mandatory presence are
  named. A giant from "Terms from Settings" with an office in the city named there is the
  exception.
- Cannot be done from Poland: "remote, US only", "must be based in Germany / UK", a work
  permit for another country, "EU citizens only", security clearance.
- Level below Senior: the role is called that (Mid, Regular, Junior) or the experience is
  capped ("2–4 years"). "3+ years", "at least N years" is a lower bound, not a level.
- The main stack is not yours: list the frameworks and platforms you will not take. Also a
  required backend not in JS/TS, even in a fullstack role with a React frontend.
- The wrong role: pure backend, DevOps / SRE, ML / data science, QA, management with no code,
  a non-engineering role.
- A language other than English is required, or Polish above your level (see "Terms from
  Settings").
- The posting is closed or no longer takes applications.

## The finer points

- No salary in the text is normal: do not lower the verdict for it or list it as a concern;
  the card shows that by itself.
- Do not invent checks the text is silent on: no citizenship restrictions, no mention of
  citizenship; nothing about the contract, nothing about the contract.
- The board already says "remote" or "zdalnie" and the text is silent on the format: take it
  as remote. Both silent: that is a "maybe", for the candidate to check.
- A role's title alone can be a stop factor (Engineering Manager, Mid, Java Developer), even
  with almost no text.
- The level is not named but the requirements are clearly senior (5+ years, owning the
  architecture): take it as Senior. Not named, and experience "from 3 years" with no other
  signs: "maybe".
- LinkedIn's "Seniority level" field (Associate, Entry level, Mid-Senior level) at the start of
  the text is not the role's level: look at the title and the requirements.
- "Remote-first, office if you like" is remote. Remote as one of the options ("100% remote lub
  hybrid", "remote or office, your choice") is remote too.
- Required US hours (all of PST / EST) is a concern, not a stop factor, if the posting is
  otherwise good.
- Platforms that need an account and a selection (Toptal, Turing, lemon.io and so on): note it
  in the concerns. An ordinary recruitment agency is no concern.
- Money alone is not a stop factor. The top of the published range under the floor is a "maybe"
  scored no higher than 55, with the concern "range below the floor". The floor inside the
  range: look at its middle. The middle at the floor or above: the money is fine; below: "maybe".
  The board data already converted the range ("B2B-equivalent", "the middle is below the
  candidate's floor"): trust that conversion.
