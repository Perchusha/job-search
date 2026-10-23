import assert from "node:assert/strict";

import { presentJob, rankFetched, rankJobs } from "../src/pipeline.ts";
import { seniorityBucket } from "../src/profile.ts";
import { buildContext, decide } from "../src/screening.ts";
import { dedupeJobs } from "../src/sources.ts";

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
