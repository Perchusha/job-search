/**
 * Offline checks for the Polish board parsers (src/boards-pl.ts). The pages
 * below are cut down to the parts the parsers read, in the shapes measured on
 * the live sites in October 2026: nofluffjobs' Angular serverApp-state, and
 * justjoin.it's Next.js flight chunks. No network.
 *
 *   node --import tsx tests/boards.mjs
 */

import {
  belowSalaryFloor,
  formatPay,
  normalizeJustJoin,
  normalizeNoFluff,
  parseJustJoinPage,
  parseNoFluffPage,
  payB2bPlnMonth,
} from "../src/boards-pl.ts";

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

/* ---- nofluffjobs ---- */

const nfjState = {
  "a1b2c3": {
    postings: [
      {
        id: "senior-react-electron-developer-scalo-Remote",
        name: "Scalo",
        posted: Date.parse("2026-10-20T10:00:00Z"),
        renewed: Date.parse("2026-10-22T10:00:00Z"),
        title: "Senior React / Electron Developer",
        seniority: ["Senior"],
        url: "senior-react-electron-developer-scalo-remote",
        fullyRemote: false,
        location: { places: [{ city: "Remote" }, { city: "Kraków" }] },
        salary: { from: 130, to: 150, type: "b2b", currency: "PLN", period: "Hour" },
        tiles: { values: [{ value: "frontend", type: "category" }, { value: "React", type: "requirement" }] },
      },
    ],
    totalCount: 1,
    additionalSearch: [{ id: "suggestion-not-matching-the-filter", title: "Ignored" }],
  },
};
const nfjHtml = `<html><body><script id="serverApp-state" type="application/json">${JSON.stringify(nfjState)}</script></body></html>`;

const nfjPostings = parseNoFluffPage(nfjHtml);
check("nofluffjobs: postings found, suggestions ignored", nfjPostings.length === 1);
const nfj = normalizeNoFluff(nfjPostings[0]);
check("nofluffjobs: offer URL", nfj?.url === "https://nofluffjobs.com/pl/job/senior-react-electron-developer-scalo-remote");
check("nofluffjobs: a 'Remote' place means remote", nfj?.remote === true && nfj?.workMode === "remote");
check("nofluffjobs: posted, not renewed, is the age", nfj?.postedAt === "2026-10-20T10:00:00.000Z");
check("nofluffjobs: pay keeps its contract and unit", nfj?.salary === "B2B 130–150 PLN/h", nfj?.salary);
check("nofluffjobs: requirements become tags", nfj?.tags.includes("React"));

const escaped = `<script id="serverApp-state" type="application/json">${JSON.stringify(nfjState).replace(/"/g, "&q;")}</script>`;
check("nofluffjobs: Angular-escaped state still parses", parseNoFluffPage(escaped).length === 1);

let threw = false;
try {
  parseNoFluffPage("<html>redesigned</html>");
} catch {
  threw = true;
}
check("nofluffjobs: a page without the state throws (shows up as skipped)", threw);

/* ---- justjoin.it ---- */

const offer = {
  guid: "1848408f-aacd-4287-b1f9-fb48356e35a1",
  slug: "dcg-senior-frontend-developer-react-next-js--warszawa-javascript-5819705a",
  title: "Senior Frontend Developer (React+Next.js)",
  companyName: "DCG",
  city: "Warszawa",
  workplaceType: "remote",
  experienceLevel: "senior",
  requiredSkills: ["React", "Next.js", "TypeScript"],
  niceToHaveSkills: ["Angular"],
  publishedAt: "2026-10-23T14:05:13Z",
  lastPublishedAt: "2026-09-23T13:24:34Z",
  employmentTypes: [
    { from: 24000, to: 28000, currency: "PLN", currencySource: "original", type: "b2b", unit: "month", gross: false },
    { from: 5600, to: 6500, currency: "EUR", currencySource: "conversion", type: "b2b", unit: "month", gross: false },
    { from: 20000, to: 24000, currency: "PLN", currencySource: "original", type: "permanent", unit: "month", gross: true },
  ],
};
// The flight payload is a JS string inside push([1,"…"]), and the offer sits
// inside a larger React tree, as on the real page.
const flight = `0:["$","div",null,{"children":{"offers":[${JSON.stringify(offer)}],"count":1}}]`;
const jjHtml = `<script>self.__next_f.push([1,${JSON.stringify(flight.slice(0, 40))}])</script>`
  + `<script>self.__next_f.push([1,${JSON.stringify(flight.slice(40))}])</script>`;

const jjOffers = parseJustJoinPage(jjHtml);
check("justjoin: offer reassembled across flight chunks", jjOffers.length === 1);
const jj = normalizeJustJoin(jjOffers[0]);
check("justjoin: offer URL", jj?.url === `https://justjoin.it/job-offer/${offer.slug}`);
check("justjoin: converted currencies are dropped", jj?.pay?.length === 2, JSON.stringify(jj?.pay));
check("justjoin: both contracts shown",
  jj?.salary === "B2B 24k–28k PLN/mo · UoP 20k–24k PLN/mo gross", jj?.salary);
check("justjoin: nice-to-have skills do not become tags", !jj?.tags.includes("Angular"));
check("justjoin: the older of the two publish stamps is the age", jj?.postedAt === "2026-09-23T13:24:34.000Z");

/* ---- pay ---- */

const hourly = payB2bPlnMonth([{ contract: "b2b", min: 130, max: 150, currency: "PLN", unit: "hour", gross: false }]);
check("pay: hourly B2B × 168 h", hourly?.min === 130 * 168 && hourly?.max === 150 * 168);
const uop = payB2bPlnMonth([{ contract: "uop", min: 20000, max: 24000, currency: "PLN", unit: "month", gross: true }]);
check("pay: UoP gross scaled by my UoP↔B2B equivalence (34k gross = 27.5k B2B)",
  Math.round(uop?.max ?? 0) === Math.round(24000 * (27500 / 34000)));
check("pay: UoP 34k gross is exactly at my B2B target, so above the floor",
  !belowSalaryFloor({ pay: [{ contract: "uop", min: 30000, max: 34000, currency: "PLN", unit: "month", gross: true }] }));
check("pay: UoP 28k gross is under the floor (≈22.6k B2B)",
  belowSalaryFloor({ pay: [{ contract: "uop", min: 24000, max: 28000, currency: "PLN", unit: "month", gross: true }] }));
check("pay: below the floor", belowSalaryFloor({ pay: [{ contract: "b2b", min: 18000, max: 23000, currency: "PLN", unit: "month", gross: false }] }));
check("pay: unknown pay is never below the floor", !belowSalaryFloor({ pay: [] }) && !belowSalaryFloor({}));
check("pay: nothing published, nothing formatted", formatPay([]) === null);

console.log(failed === 0 ? "\nBOARD TESTS PASSED" : `\n${failed} BOARD TEST(S) FAILED`);
if (failed > 0) process.exitCode = 1;
