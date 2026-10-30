# Candidate profile — the facts application forms ask for

Copy this file to `profile.md` (gitignored) and fill it in; `profile.json` holds the
same facts for the scripts. This one is the prose: the reasoning behind each answer.

Source of truth for every field a form can ask. Anything marked **CONFIRM** is
not known yet: leave the field empty if optional, and if it is required, stop,
do not submit, and put the job on the "needs you" list with the field name.

## Identity

| Field | Value |
| --- | --- |
| Full name | Jane Doe |
| First / last | Jane / Doe |
| Email | jane.doe@example.com |
| Phone | +48 500 000 000 (country code PL, +48) |
| Location | Warsaw, Poland (Mazowieckie) |
| Time zone | Europe/Warsaw (CET/CEST) |
| Pronouns | leave blank |

## Links

| Field | Value |
| --- | --- |
| LinkedIn | https://www.linkedin.com/in/jane-doe/ |
| GitHub | https://github.com/jane-doe |
| Portfolio / website | https://jane-doe.dev/ |

## CV

- File: the path in `cvPath` (profile.json). Upload it as the resume on every form.
  Never paste it as text unless the form has no upload.
- Headline: **Senior Software Engineer** — N years, TypeScript / React / Node.js.
- Current role: …
- Previous: …
- Education: …
- Years of experience: N (professional, since …). React: N+. TypeScript: N+.

## Eligibility and logistics

| Question | Answer |
| --- | --- |
| Work location | Remote only. Poland-based. Will not relocate. |
| Right to work | Poland: yes. Other EU countries / US / UK: say what is true for you, and whether sponsorship would be needed. |
| Citizenship / nationality | Only answer if the field is required. |
| Languages | English (C1), Polish (B1). |
| Contract type | B2B or employment contract (umowa o pracę). |
| Salary expectation | B2B: … PLN net/month. UoP: … PLN gross/month. apply.mjs picks by the field label, then by `--contract`; with neither it gives both in free text and the B2B number in a bare box. |
| Notice period / start date | … |
| Willing to travel | Occasionally, for team meetups. |
| Gender / ethnicity / disability / veteran (EEO) | "Prefer not to say" / "Decline to self-identify". |
| How did you hear about us | "Job board" / "Indeed" / "LinkedIn" / "Himalayas" — whichever the posting came from. |
| Previously applied / employed here | No (check `node scripts/funnel.mjs applied` first). |
| Consent to data processing / privacy policy | Tick the one required for the application. Do not tick marketing / talent-pool / future-roles boxes. |

## Short answers that come up

- **Why this role?** Tie it to one concrete thing in the posting (product, stack,
  domain) and one matching CV fact. Two sentences.
- **Biggest achievement**: …
- **Frontend highlights**: …
- **Leadership**: …
