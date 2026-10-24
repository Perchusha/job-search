import assert from "node:assert/strict";

import { inDateWindow, presentJob, rankFetched, rankJobs } from "../src/pipeline.ts";
import { seniorityBucket } from "../src/profile.ts";
import { scoreEligibility } from "../src/eligibility.ts";
import { SCREEN_RULES, buildContext, decide, ruleOf } from "../src/screening.ts";
import { dedupeJobs } from "../src/sources.ts";
import { belowSalaryFloor, payVsFloor } from "../src/boards-pl.ts";
import { workSignals } from "../src/workmode.ts";

function job(title, eligibilityLevel, overrides = {}) {
  return {
    source: "linkedin",
    externalId: title,
    title,
    company: "Example",
    url: `https://example.com/${encodeURIComponent(title)}`,
    location: "Poland",
    remote: false,
    salary: null,
    salaryMin: null,
    salaryMax: null,
    tags: [],
    postedAt: "2026-08-30T00:00:00.000Z",
    locationRestrictions: [],
    eligibility: {
      eligible: true,
      level: eligibilityLevel,
      reason: eligibilityLevel === "high" ? "confirmed" : "check location",
    },
    ...overrides,
  };
}

const strongButUnconfirmed = job("Senior React Developer", "medium");
const partialButConfirmed = job("Senior Full-stack Developer", "high");
const ranked = rankJobs([partialButConfirmed, strongButUnconfirmed]);

assert.equal(
  ranked[0].title,
  "Senior React Developer",
  "professional fit must outrank incomplete geography metadata",
);

const presented = presentJob(strongButUnconfirmed);
assert.equal(presented.match.level, "high");
assert.equal(presented.eligibility.level, "medium");

console.log("PASS  ranking: strong React + geo check beats partial fit + confirmed geo");
console.log("PASS  presentation: professional match and eligibility are separate");

/* ---- Himalayas per-country variants: the Poland copy survives dedupe ---- */
const ukFirst = dedupeJobs([
  job("Frontend Engineer", "high", { source: "himalayas", url: "https://himalayas.app/j/fe-uk", locationRestrictions: ["United Kingdom"] }),
  job("Frontend Engineer", "high", { source: "himalayas", url: "https://himalayas.app/j/fe-pl", locationRestrictions: ["Poland"] }),
]);
assert.equal(ukFirst.length, 1);
assert.equal(ukFirst[0].url, "https://himalayas.app/j/fe-pl", "a variant open to Poland must replace one that is not");
const plFirst = dedupeJobs([
  job("Frontend Engineer", "high", { source: "himalayas", url: "https://himalayas.app/j/fe-pl", locationRestrictions: ["Poland"] }),
  job("Frontend Engineer", "high", { source: "himalayas", url: "https://himalayas.app/j/fe-de", locationRestrictions: ["Germany"] }),
]);
assert.equal(plFirst[0].url, "https://himalayas.app/j/fe-pl", "the Poland copy stays when it came first");
console.log("PASS  dedupe: a Himalayas variant open to Poland wins over another country's");

const merged = dedupeJobs([
  job("Senior React Engineer", "high", { source: "indeed", url: "https://comm-it.com/jobs#1", company: "COMMIT" }),
  job("Senior React Engineer", "high", {
    source: "himalayas", url: "https://himalayas.app/j/commit", company: "CommIT", salary: "PLN 23k–30k / monthly",
    pay: [{ contract: "other", min: 23000, max: 30000, currency: "PLN", unit: "month", gross: false }],
  }),
]);
assert.equal(merged.length, 1);
assert.equal(merged[0].source, "indeed", "the first copy still wins");
assert.equal(merged[0].salary, "PLN 23k–30k / monthly", "but keeps the pay only the other copy published");
console.log("PASS  dedupe: the surviving copy keeps pay published only by its duplicate");

/* ---- minSalary: PLN per month, B2B-equivalent, through the pay ranges ---- */
const paid = (title, pay) => job(title, "high", { source: "himalayas", remote: true, pay, tags: ["React"] });
const result = rankFetched(
  {
    jobs: [
      paid("Senior React Engineer A", [{ contract: "other", min: 23000, max: 30000, currency: "PLN", unit: "month", gross: false }]),
      paid("Senior React Engineer B", [{ contract: "b2b", min: 130, max: 150, currency: "PLN", unit: "hour", gross: false }]),
      paid("Senior React Engineer C", [{ contract: "other", min: 1200000, max: 1200000, currency: "INR", unit: "year", gross: false }]),
      paid("Senior React Engineer D", []),
    ],
    reports: [],
    queries: [],
  },
  { minSalary: 25000, limit: 10 },
);
assert.deepEqual(
  result.jobs.map((j) => j.title).sort(),
  ["Senior React Engineer A", "Senior React Engineer B"],
  "PLN 30k/month and 150 PLN/h meet a 25k floor; INR 1.2M/yr and unknown pay do not",
);
console.log("PASS  minSalary: monthly, hourly and foreign figures compared in one unit");

/* ---- board seniority tags demote, never gate ---- */
assert.equal(seniorityBucket(job("Frontend Engineer", "high", { tags: ["Mid-level"] })), 1.5);
assert.equal(seniorityBucket(job("Frontend Engineer", "high", { tags: ["Senior"] })), 0);
assert.equal(seniorityBucket(job("Frontend Engineer", "high", { seniorityLevel: "senior" })), 0);
assert.equal(seniorityBucket(job("Junior Frontend Engineer", "high", { tags: ["Senior"] })), 2, "the title decides first");
console.log("PASS  seniority: a board's Mid-level tag demotes a title that names no level");

/* ---- known pay under the floor is flagged by the screening rules ---- */
const lowPay = decide(
  { title: "Senior React Developer", company: "Link Group", url: "https://example.com/lg", source: "nofluffjobs",
    postedAt: null, salary: "B2B 18k–23k PLN/mo",
    pay: [{ contract: "b2b", min: 18000, max: 23000, currency: "PLN", unit: "month", gross: false }],
    eligibility: { level: "high", reason: "Remote, Polish board" } },
  buildContext([], []),
);
assert.ok(lowPay.flags.some((flag) => flag.startsWith("зарплата ниже порога")), JSON.stringify(lowPay.flags));
assert.equal(lowPay.bucket, "apply", "a flag, not a hide");
console.log("PASS  screening: published pay under the floor is flagged, not hidden");

/* ---- a giant's office in Warsaw is not friction, elsewhere it still is ---- */
const officeDays = "This is a hybrid role: 3 days a week in the office.";
const giantWarsaw = job("Senior Frontend Engineer", "high", { company: "Google", location: "Warszawa, MZ, PL", description: officeDays });
const giantKrakow = job("Senior Frontend Engineer", "high", { company: "Google", location: "Kraków, ML, PL", description: officeDays });
const remoteRole = job("Senior Frontend Engineer", "high", { company: "Example", location: "zdalnie, PL", postedAt: "2026-08-01T00:00:00.000Z" });
assert.deepEqual(
  rankJobs([giantKrakow, remoteRole, giantWarsaw]).map((j) => j.location),
  ["Warszawa, MZ, PL", "zdalnie, PL", "Kraków, ML, PL"],
  "office days in Warsaw at Google rank like remote; in Kraków they still sink",
);
const indeedGiant = (location) =>
  decide(
    { title: "Senior Software Engineer, Frontend", company: "Google", url: `https://example.com/${location}`, source: "indeed",
      postedAt: null, eligibility: scoreEligibility(job("x", "high", { source: "indeed", company: "Google", location })) },
    buildContext([], []),
  );
assert.equal(indeedGiant("Warszawa, MZ, PL").bucket, "apply", "Google onsite in Warsaw is not hidden by the Indeed onsite rule");
assert.equal(indeedGiant("Kraków, ML, PL").bucket, "dismiss", "Google onsite in Kraków still is");
console.log("PASS  office: a giant in Warsaw is not demoted or hidden for office days; in Kraków it is");

/* ---- the same role applied to through another board is a rule hit ---- */
const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
const xebiaApp = (appliedDays) => ({
  id: 95, title: "Senior React Developer with NX and AI", company: "Xebia", status: "applied",
  url: "https://nofluffjobs.com/pl/job/xebia-nx", applied_at: daysAgo(appliedDays), source: "nofluffjobs",
});
const xebiaCopy = {
  title: "Senior React Developer with NX and AI (m/f/d)", company: "Xebia sp. z o.o.", url: "https://justjoin.it/job-offer/xebia-nx",
  source: "justjoin", postedAt: null, eligibility: { level: "high", reason: "Remote, Polish board" },
};
const copyHit = decide(xebiaCopy, buildContext([xebiaApp(3)], []));
assert.equal(copyHit.bucket, "dismiss", JSON.stringify(copyHit));
assert.ok(copyHit.reason.startsWith("already applied to this role: #95"), copyHit.reason);
assert.equal(decide(xebiaCopy, buildContext([xebiaApp(90)], [])).bucket, "apply", "after REAPPLY_AFTER_DAYS a repost shows again");
const generic = decide(
  { title: "Senior Software Engineer", company: "Google", url: "https://example.com/g2", source: "linkedin", postedAt: null,
    eligibility: { level: "medium", reason: "check" } },
  buildContext([{ id: 7, title: "Senior Software Engineer", company: "Google", status: "applied", url: "https://example.com/g1", applied_at: daysAgo(3) }], []),
);
assert.notEqual(generic.bucket, "dismiss", "a title that names no role is not one job at a big company");
const epam = decide(
  { title: "Lead Full Stack Engineer", company: "EPAM Systems", url: "https://example.com/epam-lead", source: "linkedin", postedAt: null,
    eligibility: { level: "medium", reason: "check" } },
  buildContext([{ id: 11, title: "Senior Full Stack Engineer", company: "EPAM Systems", status: "applied", url: "https://example.com/epam-senior", applied_at: daysAgo(3) }], []),
);
assert.notEqual(epam.bucket, "dismiss", "the Lead and Senior openings of a team are two roles");
console.log("PASS  screening: a role applied to on another board is hidden; generic titles and other levels are not");

/* ---- dedupe folds spellings of one company and keeps the copies' keys ---- */
const folded = dedupeJobs([
  job("Senior React Developer with NX and AI", "high", { source: "nofluffjobs", company: "Xebia sp. z o.o.", url: "https://nofluffjobs.com/pl/job/xebia-nx" }),
  job("Senior React Developer with NX and AI (m/f/d)", "high", { source: "justjoin", company: "Xebia", url: "https://justjoin.it/job-offer/xebia-nx" }),
]);
assert.equal(folded.length, 1);
assert.deepEqual(folded[0].aliasKeys, ["justjoin.it/job-offer/xebia-nx"]);
const viaAlias = decide(
  { ...folded[0], eligibility: { level: "high", reason: "Remote" } },
  buildContext([{ id: 1, title: "x", company: "Xebia", status: "applied", url: "https://justjoin.it/job-offer/xebia-nx", applied_at: daysAgo(1) }], []),
);
assert.equal(viaAlias.bucket, "skip", "an application on the folded copy counts");
console.log("PASS  dedupe: one company under two spellings is one card, and its copies' keys come along");

/* ---- the criteria's two pay states: top under the floor, middle under it ---- */
const range = (min, max, unit = "month") => ({ pay: [{ contract: "b2b", min, max, currency: "PLN", unit, gross: false }] });
assert.equal(payVsFloor(range(18000, 23000)), "below");
assert.equal(payVsFloor(range(22400, 26500)), "midlow", "the floor inside, the middle under it");
assert.equal(payVsFloor(range(140, 150, "hour")), "midlow", "Scalo's 140–150 PLN/h: 23.5k–25.2k");
assert.equal(payVsFloor(range(23500, 33500)), "ok", "the middle above the floor");
assert.equal(payVsFloor(range(20000, null)), "midlow", "\"od 20k\": the top is unknown, so a doubt");
assert.equal(payVsFloor({ pay: [] }), null);
assert.ok(!belowSalaryFloor(range(22400, 26500)), "only a top under the floor demotes and asks before applying");
const midFlag = decide(
  { title: "Senior Full Stack Engineer", company: "teems.it", url: "https://example.com/teems", source: "nofluffjobs", postedAt: null,
    salary: "B2B 22.4k–26.5k PLN/mo", ...range(22400, 26500), eligibility: { level: "high", reason: "Remote, Polish board" } },
  buildContext([], []),
);
assert.ok(midFlag.flags.some((flag) => flag.startsWith("середина вилки ниже порога")), JSON.stringify(midFlag.flags));
console.log("PASS  pay: top under the floor is below, the middle under it is a doubt, as the criteria say");

/* ---- an offer its board still lists stays in the month window ---- */
const old = (listed) => job("Senior Frontend Developer", "high", { source: "justjoin", postedAt: daysAgo(50), listed });
assert.ok(inDateWindow(old(true), 720), "listed at 50 days: open");
assert.ok(!inDateWindow(old(false), 720), "gone from the listing at 50 days: out");
assert.ok(!inDateWindow(old(true), 168), "a week's window still means posted this week");
console.log("PASS  window: an offer still listed by its board stays in the month window, not in narrower ones");

/* ---- hides a rule wrote are not my judgement of the role ---- */
const reactHide = (reason) => ({ url: `https://example.com/acme-${reason}`, title: "Senior React Developer", company: "Acme", reason });
const acmeRepost = (hides) =>
  decide(
    { title: "Senior React Developer (m/f/d)", company: "Acme sp. z o.o.", url: "https://example.com/acme-2", source: "linkedin", postedAt: null,
      eligibility: { level: "medium", reason: "check" } },
    buildContext([], hides),
  );
assert.ok(acmeRepost([reactHide(null)]).reason.startsWith("same role hidden earlier"), "my own hide of the same role is evidence");
for (const reason of ["backend-only role", "auto: backend-only role"]) {
  assert.ok(!acmeRepost([reactHide(reason)]).reason.startsWith("same role hidden earlier"), reason);
}
console.log("PASS  screening: rule-written hides, bare or auto:, are not evidence for \"same role hidden earlier\"");

/* ---- "same role" needs the role named: no one-word matches, no other team, no other level ---- */
const hiddenOne = (title, company = "Example") => ({ url: `https://example.com/h-${encodeURIComponent(title)}`, title, company, reason: null, dismissed_at: daysAgo(40) });
const against = (title, hides, company = "Example") =>
  decide({ title, company, url: `https://example.com/j-${encodeURIComponent(title)}`, source: "linkedin", postedAt: null,
    eligibility: { level: "medium", reason: "check" } }, buildContext([], hides)).reason;
assert.ok(!against("Senior Software Engineer", [hiddenOne("Lead Software Engineer")]).startsWith("same role"), "titles naming no role are not one role");
assert.ok(!against("Full Stack Engineer", [hiddenOne("Senior / Principal Full Stack Software Engineer")]).startsWith("same role"), "one shared word is not one role");
assert.ok(!against("Front End Engineer, Risk Technology", [hiddenOne("Front End Engineer, Execution Technology")]).startsWith("same role"), "another team");
assert.ok(!against("Senior Software Engineer, Front End, Google Messages", [hiddenOne("Software Engineer II, Google Messages, Front End", "Google")], "Google").startsWith("same role"), "a hidden mid-level opening does not hide the senior one");
assert.ok(against("Senior Frontend Engineer, Payments Platform Team", [hiddenOne("Senior Frontend Engineer – Payments Platform")]).startsWith("same role"), "the same role reworded");
console.log("PASS  screening: \"same role\" needs three role words, more than half shared, and the same level");

/* ---- a company is blocked by my hides only over roles I would have wanted, never a chosen one ---- */
const blocked = (hides) => buildContext([], hides).blockedCompanies;
assert.equal(blocked([hiddenOne("Copilot Studio Developer", "EY"), hiddenOne("BI Consultant", "EY")]).size, 0, "two non-target hides block nothing");
assert.equal(blocked([hiddenOne("Senior React Developer", "Acme"), hiddenOne("Frontend Engineer, Growth", "Acme")]).size, 1, "two frontend roles hidden do");
assert.equal(blocked([hiddenOne("Senior React Developer", "airSlate"), hiddenOne("Frontend Engineer, Growth", "airSlate")]).size, 0, "a WATCHLIST company only by explicit choice");
assert.equal(blocked([hiddenOne("Senior React Developer", "Google"), hiddenOne("Frontend Engineer, Growth", "Google")]).size, 0, "a giant only by explicit choice");
console.log("PASS  screening: auto-blocks count only frontend roles, and never a watched company or a giant");

/* ---- a role whose point is architecture is out; architecture inside a frontend role is not ---- */
const titled = (title) =>
  decide({ title, company: "Example", url: `https://example.com/${encodeURIComponent(title)}`, source: "linkedin", postedAt: null,
    eligibility: { level: "medium", reason: "check" } }, buildContext([], []));
assert.equal(titled("Software Architect").reason, "architect role, not hands-on product work");
assert.equal(titled("Architect Front-End Engineer (NextJs)").bucket, "dismiss");
assert.notEqual(titled("Senior Frontend Engineer, Architecture").bucket, "dismiss", "Claude reads where the emphasis is");
console.log("PASS  screening: architect titles are out; \"architecture\" inside a frontend title is left to Claude");
assert.equal(titled("Architekt systemów IT").reason, "architect role, not hands-on product work", "the Polish word's endings too");
assert.equal(titled("Architektka rozwiązań").bucket, "dismiss");
console.log("PASS  screening: architekt, architekta, architektka");

/* ---- Настройки → Правила: a rule switched off, a card freed from the rules ---- */
const php = { title: "Senior PHP Developer", company: "Example", url: "https://example.com/php", source: "linkedin", postedAt: null,
  eligibility: { level: "high", reason: "Poland" } };
assert.equal(decide(php, buildContext([], [])).reason, "PHP-first role");
assert.equal(decide(php, buildContext([], [], { rulesOff: ["PHP-first role"] })).bucket, "apply", "switched off, the rule hides nothing");
assert.equal(decide(php, buildContext([], [], { overrides: ["example.com/php"] })).bucket, "apply", "«Правило ошиблось» frees the card");
const oldPosting = { ...php, title: "Senior React Developer", url: "https://example.com/old", postedAt: "2026-06-01T00:00:00.000Z" };
assert.match(decide(oldPosting, buildContext([], [])).reason, /^posting is \d+ days old$/);
assert.equal(decide(oldPosting, buildContext([], [], { rulesOff: ["stale"] })).bucket, "apply", "the age rule switches off by its id");
const freedApplied = decide(php, buildContext([{ id: 1, title: "PHP", company: "Example", status: "applied", url: "https://example.com/php" }], [],
  { overrides: ["example.com/php"] }));
assert.equal(freedApplied.reason, "already in the funnel", "freed from the rules, an application still counts");
const hiddenTwin = { url: "https://example.com/twin", title: "Senior PHP Developer", company: "Example", reason: "не тот стек", dismissed_at: "2026-10-01T00:00:00.000Z" };
const twin = { ...php, title: "Senior React Developer", url: "https://example.com/php" };
assert.match(decide({ ...twin, title: "Senior React Developer" }, buildContext([], [{ ...hiddenTwin, title: "Senior React Developer" }])).reason, /^same role hidden earlier/);
assert.equal(decide(twin, buildContext([], [{ ...hiddenTwin, title: "Senior React Developer" }], { overrides: ["example.com/php"] })).bucket, "apply",
  "and from the memory of earlier hides");
assert.equal(ruleOf("posting is 75 days old"), "stale");
assert.equal(ruleOf("PHP-first role"), "PHP-first role");
assert.equal(ruleOf("same role hidden earlier (01.10, без причины): X"), null, "memory rules are not switchable here");
assert.ok(SCREEN_RULES.find((rule) => rule.id === "junior/intern level").words.includes("new-grad"), "a rule's words, without regex syntax");
console.log("PASS  screening: rules switch off by id; a freed card meets no hiding rule, but its application still counts");

/* ---- AI and QA exceptions read the normalised title, like every other SCREEN_FRONTEND test ---- */
assert.notEqual(titled("Senior Full-Stack AI Engineer").bucket, "dismiss", "Full-Stack is fullstack: AI in it is a bonus");
assert.notEqual(titled("Front-end Automation Engineer").bucket, "dismiss", "Front-end is frontend");
assert.equal(titled("Senior AI Engineer").reason, "AI/ML role, not frontend");
console.log("PASS  screening: «Full-Stack AI Engineer» and «Front-end Automation Engineer» are not AI or QA roles");

/* ---- Настройки → Компании и память: forget a hide, give a company back, a memory window ---- */
const memJob = { title: "Senior Frontend Engineer, Payments", company: "Memco", url: "https://example.com/mem-new", source: "linkedin",
  postedAt: null, eligibility: { level: "high", reason: "Poland" } };
const memHide = { url: "https://example.com/mem-old", title: "Senior Frontend Engineer, Payments", company: "Memco", reason: "не remote",
  dismissed_at: new Date(Date.now() - 100 * 86_400_000).toISOString() };
const remembered = decide(memJob, buildContext([], [memHide]));
assert.match(remembered.reason, /^same role hidden earlier/);
assert.deepEqual(remembered.memory, { kind: "hide", key: "example.com/mem-old" }, "a memory hit names the hide it stands on");
assert.equal(decide(memJob, buildContext([], [memHide], { forgetHides: ["example.com/mem-old"] })).bucket, "apply", "«забыть»: the hide stops teaching");
assert.equal(decide(memJob, buildContext([], [memHide], { memoryDays: 90 })).bucket, "apply", "a hide older than the window is not memory");
assert.match(decide(memJob, buildContext([], [memHide], { memoryDays: 180 })).reason, /^same role hidden earlier/, "one inside it is");
const companyNo = { url: "https://example.com/blockco-1", title: "Anything", company: "Blockco", reason: "не интересна компания",
  dismissed_at: "2025-01-01T00:00:00.000Z" };
const blockJob = { ...memJob, company: "Blockco", url: "https://example.com/blockco-2", title: "Senior React Developer" };
const blockedHit = decide(blockJob, buildContext([], [companyNo], { memoryDays: 30 }));
assert.equal(blockedHit.reason, "компания скрыта вручную", "a company I said no to stays blocked whatever the window");
assert.deepEqual(blockedHit.memory, { kind: "company", key: "blockco" });
assert.equal(decide(blockJob, buildContext([], [companyNo], { forgetCompanies: ["blockco"] })).bucket, "apply", "«вернуть» gives the company back");
console.log("PASS  screening: «забыть» a hide, «вернуть» a company, a memory window that spares «не интересна компания»");

/* ---- Polish above B1 is read in every common wording; as a plus it is not a requirement ---- */
const polish = (text) => workSignals({ description: text }).polishRequired;
for (const required of [
  "Fluency in Polish (B2+) and English (B2+)",
  "Fluent English (for client work) and at least B2 Polish",
  "Biegle posługujesz się językiem polskim i angielskim.",
  "Wymagana płynna znajomość języka polskiego.",
  "• Polski (C1)",
  "Swobodnie komunikujesz się w języku polskim.",
]) assert.ok(polish(required), required);
for (const fine of ["Polish is a plus.", "Knowledge of Polish (B2) is nice to have.", "Polish the UI until it shines."]) {
  assert.ok(!polish(fine), fine);
}
console.log("PASS  workmode: Polish above B1 in its usual wordings is a requirement; as a plus it is not");
