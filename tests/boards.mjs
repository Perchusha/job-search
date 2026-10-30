/**
 * Offline checks for the Polish board parsers (src/boards-pl.ts). The pages
 * below are cut down to the parts the parsers read, in the shapes measured on
 * the live sites in October 2026: nofluffjobs' Angular serverApp-state, and
 * justjoin.it's Next.js flight chunks; Workable's search API and Hacker News
 * posts as hn.algolia.com returns them; djinni.co's JSON-LD and DOU's RSS. No network.
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
import { normalizeJobicy, normalizeWorkable, parseHackerNewsPost } from "../src/boards-intl.ts";
import { recruitee, workable } from "../src/watchlist.ts";
import { normalizeDjinni, normalizeDou, parseDjinniPage, parseDouFeed } from "../src/boards-ua.ts";
import { scoreEligibility } from "../src/eligibility.ts";

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

/* ---- Workable ---- */

const workableRow = {
  id: "d821366f-5e38-41a6-8945-f865153b1440",
  title: "Senior Frontend Engineer (React)",
  state: "published",
  description: "<p><strong>About</strong></p><ul><li>React &amp; TypeScript</li></ul>",
  requirementsSection: "<p>5+ years of React</p>",
  benefitsSection: "",
  employmentType: "Full-time",
  department: "Technology",
  url: "https://jobs.workable.com/view/sFWwhoSJAQop12yVyiwgjh/senior-frontend-engineer-at-covergo",
  locations: ["TELECOMMUTE", "Warsaw, Masovian Voivodeship, Poland"],
  location: { city: "Warsaw", subregion: "Masovian Voivodeship", countryName: "Poland" },
  created: "2026-10-21T03:45:29.452Z",
  updated: "2026-10-28T03:45:29.452Z",
  company: { title: "CoverGo" },
  workplace: "remote",
};
const wk = normalizeWorkable(workableRow);
check("workable: title, company, the view URL", wk?.title === "Senior Frontend Engineer (React)" && wk?.company === "CoverGo" && wk?.url === workableRow.url);
check("workable: remote, listed in Warsaw, Poland", wk?.remote === true && wk?.workMode === "remote" && wk?.location === "Warsaw, Poland");
check("workable: created, not updated, is the age", wk?.postedAt === "2026-10-21T03:45:29.452Z");
check("workable: the text joins description and requirements", wk?.description?.includes("React & TypeScript") && wk?.description?.includes("5+ years of React"));
check("workable: remote in Poland scores high", scoreEligibility(wk).level === "high");
check("workable: a draft is not a posting", normalizeWorkable({ ...workableRow, state: "draft" }) === null);

/* ---- Hacker News ---- */

const hn = (id, text) => parseHackerNewsPost({ id, created_at: "2026-10-01T15:30:00.000Z", text });
const eventfirst = hn(49930919, "eventfirst | Senior Full-Stack Engineer | Berlin, Germany | REMOTE (CET) | Full-time | eventfirst.com<p>We build event software in TypeScript and React.");
check("hn: company and role from the header", eventfirst?.company === "eventfirst" && eventfirst?.title === "Senior Full-Stack Engineer");
check("hn: the post is the posting, at its HN link", eventfirst?.url === "https://news.ycombinator.com/item?id=49930919" && eventfirst?.description?.includes("TypeScript and React"));
check("hn: remote in CET scores high", eventfirst?.remote === true && scoreEligibility(eventfirst).level === "high");
const checkly = hn(1, "Checkly | https:&#x2F;&#x2F;www.checklyhq.com | Senior Product Engineer, Product Manager, Senior Sales Engineer | REMOTE (Europe &#x2F; US Eastern) | Full-time");
check("hn: of several roles, the one to apply to; entities decoded", checkly?.title === "Senior Product Engineer" && checkly?.location === "REMOTE (Europe / US Eastern)", JSON.stringify([checkly?.title, checkly?.location]));
const fastly = hn(2, "Fastly | Software Engineers (Senior, Staff, Principal) | US, UK, EU, APAC ONSITE PREFERRED | Full-time");
check("hn: commas inside parentheses keep the role whole", fastly?.title === "Software Engineers (Senior, Staff, Principal)", fastly?.title);
const modash = hn(3, "Modash.io | Senior Product Engineer | Remote (Europe) | Full-time | €75k–110k");
check("hn: a domain as the company", modash?.company === "Modash" && modash?.title === "Senior Product Engineer");
check("hn: US-only remote scores low", scoreEligibility(hn(4, "Octane | Senior Software Engineer | REMOTE (US only) or NYC/Dallas")).level === "low");
check("hn: a closed post is skipped", hn(5, "OpenSanctions | Product Engineer | Berlin / REMOTE (CET) | CLOSED NOW") === null);
check("hn: a header that names no company is skipped", hn(6, "Software Engineer — Remote — US Only<p>Kaveronix is looking for…") === null);
check("hn: a reply without text is skipped", parseHackerNewsPost({ id: 7, text: null }) === null);

/* ---- Djinni ---- */

const djinniPosting = (fields) => ({
  "@context": "https://schema.org/",
  "@type": "JobPosting",
  title: "Senior Full-Stack Developer (Node.js / React)",
  description: "<p>React and Node.js, B2B in USD.</p>",
  datePosted: "2026-10-28T19:03:04",
  hiringOrganization: { "@type": "Organization", name: "Orgmeter" },
  identifier: { "@type": "PropertyValue", value: 855689 },
  url: "https://djinni.co/jobs/855689-senior-full-stack-developer-node-js-react/",
  jobLocationType: "TELECOMMUTE",
  applicantLocationRequirements: { "@type": "AdministrativeArea", address: { "@type": "PostalAddress", addressCountry: null, addressRegion: "Europe" } },
  ...fields,
});
const djinniPage = `<html><script type="application/ld+json">${JSON.stringify([
  djinniPosting({}),
  djinniPosting({ title: "Senior Java Developer", applicantLocationRequirements: { "@type": "AdministrativeArea", address: { addressCountry: "UA" } } }),
  djinniPosting({ title: "Senior Full-Stack Engineer (TypeScript)", baseSalary: { "@type": "MonetaryAmount", currency: "USD", value: { "@type": "QuantitativeValue", minValue: 4000, maxValue: 5000, unitText: "MONTH" } } }),
  { "@type": "Organization", name: "not a posting" },
])}</script></html>`;
const djinniRows = parseDjinniPage(djinniPage);
check("djinni: JobPostings from the page's JSON-LD", djinniRows.length === 3);
const dj = normalizeDjinni(djinniRows[0]);
check("djinni: title, company, URL, remote", dj?.company === "Orgmeter" && dj?.url.endsWith("855689-senior-full-stack-developer-node-js-react/") && dj?.remote === true);
check("djinni: open to Europe scores high", dj?.location === "Europe" && scoreEligibility(dj).level === "high");
check("djinni: Ukraine only scores low", scoreEligibility(normalizeDjinni(djinniRows[1])).level === "low");
const djPaid = normalizeDjinni(djinniRows[2]);
check("djinni: published pay as a monthly USD range", djPaid?.pay?.[0]?.min === 4000 && djPaid?.pay?.[0]?.max === 5000 && djPaid?.pay?.[0]?.unit === "month", djPaid?.salary);

/* ---- DOU ---- */

const douFeed = `<?xml version="1.0" encoding="utf-8"?><rss version="2.0"><channel><title>Вакансії</title>
<item><title>Senior Frontend Developer (React) в WLTech.AI (WebLab Technology), до&amp;nbsp;$5000, віддалено</title><link>https://jobs.dou.ua/companies/weblab-technology/vacancies/219108/?utm_source=jobsrss</link><description>&lt;p&gt;&lt;strong&gt;React&lt;/strong&gt; and TypeScript&lt;/p&gt;</description><pubDate>Thu, 29 Oct 2026 16:40:23 +0200</pubDate></item>
<item><title>Senior Fullstack Engineer (React+Node.js) в Softjourn, Івано-Франківськ, Львів, за кордоном, віддалено</title><link>https://jobs.dou.ua/companies/softjourn/vacancies/1/?utm_source=jobsrss</link><description>x</description><pubDate>Thu, 30 Oct 2026 10:00:00 +0200</pubDate></item>
<item><title>Middle+ Frontend (Angular) Developer в Rational Soft, $1900–2200, Київ</title><link>https://jobs.dou.ua/companies/rational/vacancies/2/</link><description>x</description><pubDate>Fri, 17 Oct 2026 10:00:00 +0300</pubDate></item>
</channel></rss>`;
const douItems = parseDouFeed(douFeed);
check("dou: items from the feed", douItems.length === 3);
const wl = normalizeDou(douItems[0]);
check("dou: role and company split at « в », the tail read from the end", wl?.title === "Senior Frontend Developer (React)" && wl?.company === "WLTech.AI (WebLab Technology)", JSON.stringify([wl?.title, wl?.company]));
check("dou: the link without its utm_source", wl?.url === "https://jobs.dou.ua/companies/weblab-technology/vacancies/219108/");
check("dou: «до $5000» is a top of range in USD a month", wl?.pay?.[0]?.max === 5000 && wl?.pay?.[0]?.min === null && wl?.pay?.[0]?.currency === "USD");
check("dou: remote without a country is a check", wl?.remote === true && scoreEligibility(wl).level === "medium");
const sj = normalizeDou(douItems[1]);
check("dou: a hyphenated city is a place, not the company", sj?.company === "Softjourn" && sj?.location === "Івано-Франківськ, Львів, за кордоном, віддалено", JSON.stringify([sj?.company, sj?.location]));
check("dou: remote from abroad scores high", scoreEligibility(sj).level === "high");
const rs = normalizeDou(douItems[2]);
check("dou: «$1900–2200» is a range; an office in Kyiv is out of reach", rs?.pay?.[0]?.min === 1900 && rs?.pay?.[0]?.max === 2200 && scoreEligibility(rs).level === "low");

/* ---- Jobicy ---- */

const jobicy = normalizeJobicy({
  id: 157939, url: "https://jobicy.com/jobs/157939-senior-software-engineer-product-engineering-eu",
  jobTitle: "Senior Software Engineer, Product Engineering &#8211; EU", companyName: "Ashby",
  jobIndustry: ["Software Engineering"], jobType: ["Full-Time"], jobGeo: "Canada,  Poland,  UK,  USA", jobLevel: "Senior",
  jobDescription: "<p>React &amp; TypeScript</p>", pubDate: "2026-10-29T08:20:34+00:00",
  salaryMin: 103958, salaryMax: 124750, salaryCurrency: "GBP", salaryPeriod: "yearly",
});
check("jobicy: title decoded, the Jobicy page as the link", jobicy?.title === "Senior Software Engineer, Product Engineering – EU" && jobicy?.url.startsWith("https://jobicy.com/jobs/"), jobicy?.title);
check("jobicy: the countries it is open to, Poland among them, score high", jobicy?.locationRestrictions.length === 4 && scoreEligibility(jobicy).level === "high");
check("jobicy: a yearly GBP range", jobicy?.pay?.[0]?.unit === "year" && jobicy?.pay?.[0]?.currency === "GBP" && jobicy?.pay?.[0]?.max === 124750);
check("jobicy: UK only is out of reach", scoreEligibility(normalizeJobicy({ id: 1, url: "https://jobicy.com/jobs/1", jobTitle: "Frontend Engineer", companyName: "X", jobGeo: "UK" })).level === "low");

/* ---- the watchlist's Workable and Recruitee boards ---- */

const modashBoard = { vendor: "workable", board: "modash", company: "Modash" };
const wkJobs = workable(modashBoard, { jobs: [{
  title: "Senior Product Engineer (remote, Europe)", shortcode: "AB12", url: "https://apply.workable.com/j/AB12", telecommuting: true,
  country: "Poland", city: "Warsaw", locations: [{ country: "Poland", countryCode: "PL", city: "Warsaw" }],
  description: "<p>React and Node</p>", department: "Engineering", employment_type: "Full-time",
}] });
check("watchlist/workable: the role, its place and text", wkJobs[0]?.company === "Modash" && wkJobs[0]?.location === "Warsaw, Poland" && wkJobs[0]?.remote === true && wkJobs[0]?.description === "React and Node");
const rtg = { vendor: "recruitee", board: "resourcefultalentgroup", company: "Resourceful Talent Group" };
const rcJobs = recruitee(rtg, { offers: [
  { id: 1, title: "Senior Full-Stack Developer", careers_url: "https://resourcefultalentgroup.recruitee.com/o/senior-full-stack", status: "published",
    remote: true, location: "Remote job", city: "Miami", country: "United States", description: "<p>React</p>", requirements: "<p>5 years</p>",
    salary: { min: "100000", max: "150000", period: "year", currency: "USD" } },
  { id: 2, title: "Closed", careers_url: "https://x.recruitee.com/o/closed", status: "closed" },
] });
check("watchlist/recruitee: published offers only, with pay", rcJobs.length === 1 && rcJobs[0]?.pay?.[0]?.max === 150000 && rcJobs[0]?.description?.includes("React") && rcJobs[0]?.description?.includes("5 years"));
check("watchlist/recruitee: remote within the US is not open to Poland", scoreEligibility(rcJobs[0]).level === "low");

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
