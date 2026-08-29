import assert from "node:assert/strict";

import { presentJob, rankJobs } from "../src/pipeline.ts";

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
