#!/usr/bin/env node
/**
 * jobs-fetch.mjs — read job postings WITHOUT a browser and boil each down to
 * one line: work mode, stack, level, language and country constraints, the
 * ATS behind the apply button, and (where the ATS has a public API) the form
 * questions. Reading the long text costs the model nothing; it only sees the
 * line, plus the full text if it asks for it.
 *
 *   node scripts/jobs-fetch.mjs --screen <screen.json> [--buckets apply,check] [--out fetched.json]
 *   node scripts/jobs-fetch.mjs <url> [<url>...] [--out fetched.json] [--text]
 *
 * Known boards use their public JSON (LinkedIn guest API, Greenhouse,
 * Lever, Ashby, SmartRecruiters, Recruitee, Workday). Everything else is
 * fetched as HTML and stripped; a page that comes back empty (JS-only SPA)
 * is rendered once with Playwright + the installed Chrome.
 *
 * Output lines (also written to --out as JSON):
 *   idx  company — title  | vendor  | mode  | lock  | stack  | neg  | lang  | yrs  | salary  | apply: <vendor> <url>
 */

import { readFileSync, writeFileSync } from "node:fs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

async function get(url, { accept = "text/html,application/json;q=0.9,*/*;q=0.8", timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": UA, accept, "accept-language": "en-US,en;q=0.9,pl;q=0.8" },
      redirect: "follow",
      signal: controller.signal,
    });
    const body = await response.text();
    return { ok: response.ok, status: response.status, url: response.url, body };
  } catch (error) {
    return { ok: false, status: 0, url, body: "", error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url) {
  const response = await get(url, { accept: "application/json" });
  if (!response.ok) return null;
  try {
    return JSON.parse(response.body);
  } catch {
    return null;
  }
}

/** Follow redirects by hand so short links (grnh.se, lnkd.in) resolve even when the target blocks GET. */
async function resolve(url, hops = 6) {
  let current = url;
  for (let i = 0; i < hops; i += 1) {
    let response;
    try {
      response = await fetch(current, { method: "GET", redirect: "manual", headers: { "user-agent": UA } });
    } catch {
      return current;
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return current;
  }
  return current;
}

/* ------------------------------------------------------------------ */
/* HTML → text                                                         */
/* ------------------------------------------------------------------ */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", hellip: "…" };

export function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br|ul|ol|table)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pick(html, regex) {
  const match = html.match(regex);
  return match ? htmlToText(match[1]).trim() : null;
}

/* ------------------------------------------------------------------ */
/* Vendors                                                             */
/* ------------------------------------------------------------------ */

const NEEDS_ACCOUNT = /myworkdayjobs\.com|workday|indeed\.com\/job|indeed\.com\/viewjob|careers\.cognizant\.com|successfactors|taleo\.net|icims\.com|oraclecloud\.com|jobvite\.com|phenom|eightfold\.ai|avature|careers\.epam\.com|luxoft\.com/i;

export function vendorOf(url) {
  const u = url.toLowerCase();
  if (/linkedin\.com\/jobs\/view\//.test(u)) return "linkedin";
  if (/himalayas\.app\//.test(u)) return "himalayas";
  if (/greenhouse\.io/.test(u)) return "greenhouse";
  if (/jobs\.lever\.co/.test(u)) return "lever";
  if (/jobs\.ashbyhq\.com/.test(u)) return "ashby";
  if (/smartrecruiters\.com/.test(u)) return "smartrecruiters";
  if (/recruitee\.com/.test(u)) return "recruitee";
  if (/breezy\.hr/.test(u)) return "breezy";
  if (/workable\.com/.test(u)) return "workable";
  if (/traffit\.com/.test(u)) return "traffit";
  if (/teamtailor\.com|\/jobs\/\d+-[a-z0-9-]+$/.test(u)) return "teamtailor";
  if (/myworkdayjobs\.com/.test(u)) return "workday";
  if (/bamboohr\.com/.test(u)) return "bamboohr";
  if (/personio\.(de|com)/.test(u)) return "personio";
  if (/indeed\.com/.test(u)) return "indeed";
  if (NEEDS_ACCOUNT.test(u)) return "portal";
  return "web";
}

/* ---- LinkedIn guest API (no login) ---- */
// LinkedIn rate-limits the guest API hard: one request at a time, spaced out, with backoff on 429.
let linkedinQueue = Promise.resolve();
function linkedinSlot(task) {
  const run = linkedinQueue.then(task, task);
  linkedinQueue = run.then(() => sleep(2500), () => sleep(2500));
  return run;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readLinkedIn(url) {
  const id = url.match(/jobs\/view\/(\d+)/)?.[1];
  if (!id) return null;
  let response = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await linkedinSlot(() => get(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`));
    if (response.status !== 429) break;
    await sleep(8000 * (attempt + 1));
  }
  if (!response.ok) return { error: `linkedin guest api ${response.status}` };
  const html = response.body;
  const title = pick(html, /<h2[^>]*top-card-layout__title[^>]*>([\s\S]*?)<\/h2>/i) ?? pick(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const company = pick(html, /<a[^>]*topcard__org-name-link[^>]*>([\s\S]*?)<\/a>/i) ?? pick(html, /<span[^>]*topcard__flavor(?!--)[^>]*>([\s\S]*?)<\/span>/i);
  const location = pick(html, /<span[^>]*topcard__flavor--bullet[^>]*>([\s\S]*?)<\/span>/i);
  const description = pick(html, /<div[^>]*show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i) ?? pick(html, /<div[^>]*description__text[^>]*>([\s\S]*?)<\/section>/i);
  const criteria = [...html.matchAll(/<h3[^>]*description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>\s*<span[^>]*description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/gi)]
    .map((m) => `${htmlToText(m[1])}: ${htmlToText(m[2])}`);
  // The employer's own apply URL hides inside <code id="applyUrl"><!--"https://..."--></code>.
  const applyRaw = html.match(/id="applyUrl"[^>]*>\s*<!--\s*"?([^"\s]+)"?\s*-->/i)?.[1];
  const applyUrl = applyRaw ? applyRaw.replace(/&amp;/g, "&") : null;
  const closed = /job is no longer accepting applications|no longer available/i.test(html);
  return {
    title,
    company,
    location,
    text: [criteria.join(" · "), description].filter(Boolean).join("\n\n"),
    applyUrl: applyUrl ?? `${url}#easy-apply`,
    applyVendor: applyUrl ? null : "linkedin-easy-apply",
    closed,
  };
}

/* ---- Himalayas: page embeds the application link ---- */
async function readHimalayas(url) {
  // The search API carries the description and the application link; the page itself sits behind Cloudflare.
  const m = url.match(/companies\/([^/]+)\/jobs\/([^/?#]+)/);
  if (m) {
    const api = await getJson(`https://himalayas.app/jobs/api/search?q=${encodeURIComponent(m[1].replace(/-/g, " "))}&limit=50`);
    const job = api?.jobs?.find((j) => j.guid === url || (j.guid ?? "").endsWith("/" + m[2]));
    if (job) {
      const external = job.applicationLink && !/himalayas\.app/.test(job.applicationLink) ? job.applicationLink : null;
      return {
        title: job.title,
        company: job.companyName ?? m[1],
        location: (job.locationRestrictions ?? []).join(", ") || null,
        text: htmlToText(job.description ?? job.excerpt ?? ""),
        applyUrl: external ?? url,
        applyVendor: external ? null : "himalayas-account",
        closed: job.expiryDate ? (Number(job.expiryDate) < 1e12 ? Number(job.expiryDate) * 1000 : new Date(job.expiryDate).getTime()) < Date.now() : false,
      };
    }
  }
  const response = await get(url);
  let html = response.body;
  if (!response.ok) {
    // Cloudflare answers 403 to plain fetch; a real Chrome gets through.
    try {
      const rendered = await renderWithChrome(url, true);
      html = rendered.html;
    } catch (error) {
      return { error: `himalayas ${response.status}` };
    }
  }
  const applyUrl =
    html.match(/"applicationLink"\s*:\s*"([^"]+)"/)?.[1]?.replace(/\\u002F/g, "/") ??
    html.match(/href="([^"]+)"[^>]*>\s*(?:<[^>]+>\s*)*Apply(?: now| for this job)?/i)?.[1] ??
    null;
  const title = pick(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const company = html.match(/himalayas\.app\/companies\/([^/"]+)\/jobs/)?.[1] ?? null;
  return { title, company, location: null, text: htmlToText(html).slice(0, 12000), applyUrl: applyUrl && !applyUrl.startsWith("/") ? applyUrl : null, closed: /this job is (closed|no longer)/i.test(html) };
}

/* ---- Greenhouse board API, including the application questions ---- */
async function readGreenhouse(url) {
  const m = url.match(/greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i) ?? url.match(/greenhouse\.io\/embed\/job_app\?.*?for=([^&]+)&.*?token=(\d+)/i);
  if (!m) return null;
  const [, board, id] = m;
  const api = url.includes(".eu.greenhouse.io")
    ? [`https://boards-api.eu.greenhouse.io/v1/boards/${board}/jobs/${id}?questions=true`, `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}?questions=true`]
    : [`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}?questions=true`, `https://boards-api.eu.greenhouse.io/v1/boards/${board}/jobs/${id}?questions=true`];
  let job = null;
  for (const endpoint of api) {
    job = await getJson(endpoint);
    if (job?.title) break;
  }
  if (!job?.title) return { error: "greenhouse api unavailable" };
  const questions = [...(job.questions ?? []), ...(job.compliance ?? []).flatMap((c) => c.questions ?? [])].map((q) => ({
    label: q.label,
    required: Boolean(q.required),
    type: q.fields?.[0]?.type ?? "?",
    options: (q.fields?.[0]?.values ?? []).map((v) => v.label).slice(0, 12),
  }));
  return {
    title: job.title,
    company: job.company_name ?? board,
    location: job.location?.name ?? null,
    text: htmlToText(job.content ?? ""),
    applyUrl: job.absolute_url ?? url,
    questions,
    closed: false,
  };
}

/* ---- Lever postings API ---- */
async function readLever(url) {
  const m = url.match(/jobs\.lever\.co\/([^/]+)\/([0-9a-f-]{36})/i);
  if (!m) return null;
  const job = await getJson(`https://api.lever.co/v0/postings/${m[1]}/${m[2]}`);
  if (!job?.text) return { error: "lever api unavailable" };
  const lists = (job.lists ?? []).map((l) => `${l.text}\n${htmlToText(l.content)}`).join("\n");
  return {
    title: job.text,
    company: m[1],
    location: [job.categories?.location, job.workplaceType].filter(Boolean).join(" · "),
    text: [job.descriptionPlain, lists, job.additionalPlain].filter(Boolean).join("\n\n"),
    applyUrl: job.applyUrl ?? `${url}/apply`,
    closed: false,
  };
}

/* ---- Ashby job board API ---- */
async function readAshby(url) {
  const m = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/i);
  if (!m) return null;
  const board = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${m[1]}?includeCompensation=true`);
  const job = board?.jobs?.find((j) => j.id === m[2] || (j.jobUrl ?? "").includes(m[2]));
  if (!job) return { error: "ashby posting not on board (closed?)", closed: true };
  return {
    title: job.title,
    company: m[1],
    location: [job.location, job.isRemote ? "remote" : null, job.employmentType].filter(Boolean).join(" · "),
    text: [job.descriptionPlain ?? htmlToText(job.descriptionHtml ?? ""), job.compensation?.compensationTierSummary].filter(Boolean).join("\n\n"),
    applyUrl: job.applyUrl ?? `${url}/application`,
    closed: false,
  };
}

/* ---- SmartRecruiters posting API ---- */
async function readSmartRecruiters(url) {
  const m = url.match(/smartrecruiters\.com\/([^/]+)\/(\d+)/i);
  if (!m) return null;
  const job = await getJson(`https://api.smartrecruiters.com/v1/companies/${m[1]}/postings/${m[2]}`);
  if (!job?.name) return { error: "smartrecruiters api unavailable" };
  const sections = Object.values(job.jobAd?.sections ?? {}).map((s) => `${s.title ?? ""}\n${htmlToText(s.text ?? "")}`);
  const loc = job.location ?? {};
  return {
    title: job.name,
    company: job.company?.name ?? m[1],
    location: [loc.city, loc.country, loc.remote ? "remote" : null].filter(Boolean).join(", "),
    text: sections.join("\n\n"),
    applyUrl: job.applyUrl ?? url,
    closed: job.active === false,
  };
}

/* ---- Recruitee offers API ---- */
async function readRecruitee(url) {
  const m = url.match(/https?:\/\/([^.]+)\.recruitee\.com\/o\/([^/?#]+)/i);
  if (!m) return null;
  const data = await getJson(`https://${m[1]}.recruitee.com/api/offers/${m[2]}`);
  const job = data?.offer;
  if (!job) return { error: "recruitee api unavailable" };
  return {
    title: job.title,
    company: job.company_name ?? m[1],
    location: [job.location, job.remote ? "remote" : null, job.hybrid ? "hybrid" : null].filter(Boolean).join(" · "),
    text: htmlToText([job.description, job.requirements].filter(Boolean).join("\n")),
    applyUrl: `https://${m[1]}.recruitee.com/o/${m[2]}/c/new`,
    questions: (job.open_questions ?? []).map((q) => ({ label: q.body ?? q.name, required: Boolean(q.required), type: q.kind, options: (q.open_question_options ?? []).map((o) => o.body).slice(0, 12) })),
    closed: job.status === "closed",
  };
}

/* ---- Workday: description only; applying needs an account ---- */
async function readWorkday(url) {
  const m = url.match(/https?:\/\/([^.]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)\/job\/(.+)$/i);
  if (!m) return null;
  const job = await getJson(`https://${m[1]}.${m[2]}.myworkdayjobs.com/wday/cxs/${m[1]}/${m[3]}/job/${m[4]}`);
  const info = job?.jobPostingInfo;
  if (!info) return { error: "workday api unavailable" };
  return {
    title: info.title,
    company: m[1],
    location: [info.location, info.remoteType].filter(Boolean).join(" · "),
    text: htmlToText(info.jobDescription ?? ""),
    applyUrl: url,
    applyVendor: "portal",
    closed: false,
  };
}

/* ---- Generic HTML, with a Playwright fallback for JS-only pages ---- */
let browserPromise = null;
async function renderWithChrome(url, wantHtml = false) {
  if (!browserPromise) {
    browserPromise = import("playwright").then(({ chromium }) => chromium.launch({ channel: "chrome", headless: true }));
  }
  const browser = await browserPromise;
  const page = await browser.newPage({ userAgent: UA });
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    const title = await page.title();
    const applyHref = await page.evaluate(() => {
      const el = [...document.querySelectorAll("a,button")].find((e) => /^\s*(apply|aplikuj|i'm interested|apply now|apply for this job)/i.test(e.textContent ?? ""));
      return el?.getAttribute("href") ?? null;
    });
    const html = wantHtml ? await page.content() : null;
    return { text, title, applyHref, finalUrl: page.url(), html };
  } finally {
    await page.close();
  }
}

async function readGeneric(url) {
  const response = await get(url);
  let text = htmlToText(response.body);
  let title = pick(response.body, /<title[^>]*>([\s\S]*?)<\/title>/i);
  let applyUrl = response.body.match(/href="([^"]+)"[^>]*>\s*(?:<[^>]+>\s*)*(?:Apply|Aplikuj|I'm interested)/i)?.[1] ?? null;
  let finalUrl = response.url;
  if (!response.ok || text.length < 500) {
    try {
      const rendered = await renderWithChrome(url);
      text = rendered.text;
      title = rendered.title;
      applyUrl = rendered.applyHref ?? applyUrl;
      finalUrl = rendered.finalUrl;
    } catch (error) {
      if (!response.ok) return { error: `http ${response.status}${response.error ? " " + response.error : ""}` };
    }
  }
  if (applyUrl && applyUrl.startsWith("/")) applyUrl = new URL(applyUrl, finalUrl).toString();
  return { title, company: null, location: null, text: text.slice(0, 15000), applyUrl: applyUrl ?? finalUrl, finalUrl, closed: /no longer (accepting|available)|position (has been )?(filled|closed)|job (is )?(closed|expired)/i.test(text) };
}

async function readPosting(url) {
  const vendor = vendorOf(url);
  const readers = {
    linkedin: readLinkedIn,
    himalayas: readHimalayas,
    greenhouse: readGreenhouse,
    lever: readLever,
    ashby: readAshby,
    smartrecruiters: readSmartRecruiters,
    recruitee: readRecruitee,
    workday: readWorkday,
  };
  const reader = readers[vendor];
  const result = (reader ? await reader(url) : null) ?? (await readGeneric(url));
  return { vendor, ...result };
}

/* ------------------------------------------------------------------ */
/* Signals                                                             */
/* ------------------------------------------------------------------ */

const W = (p) => new RegExp(`(?<![a-z0-9])(?:${p})(?![a-z0-9])`, "gi");

const REMOTE = W("remote|remotely|remote-first|fully remote|100% remote|zdalnie|zdalna|zdalnej|praca zdalna|work from anywhere|work from home|wfh|home office|home-based|distributed team");
// Doubled backslashes: W() builds the RegExp from a string, and "\d" / "\s" in
// a plain string literal are just "d" / "s" — this branch never matched before.
const HYBRID = W("hybrid|hybrydow[a-z]*|(?:\\d|one|two|three|four)\\s+days?\\s+(?:per|a|each)\\s+(?:week|month)|days? (?:per|a|each) (?:week|month) (?:in|at|from) (?:the )?office|office days|in[- ]office|from (?:the|our) office|on[- ]?site(?! gym| parking| cafeteria| canteen| kitchen| restaurant)|stacjonarn[a-z]*|at our (?:warsaw|krak[oó]w|cracow|wroc[lł]aw|gda[nń]sk|pozna[nń]) office");
const ONSITE = W("on[- ]?site only|office[- ]based|no remote|not remote|relocat(?:e|ion) (?:to|is required)|must relocate|work from (?:the|our) office");
const COUNTRY_LOCK = /(?:must|need(?:s)? to|should|have to|required to)\s+(?:be\s+)?(?:based|located|reside|residing|living|live)\s+(?:in|within)\s+(?:the\s+)?([A-Z][A-Za-z.]+(?:\s[A-Z][A-Za-z.]+)?)|(?:only|exclusively)\s+(?:for\s+)?(?:candidates|applicants)\s+(?:based|located|residing)\s+(?:in|within)\s+(?:the\s+)?([A-Z][A-Za-z.]+)|([A-Z][A-Za-z.]+)[- ]based (?:candidates|applicants|only)|authori[sz]ed to work in (?:the\s+)?(United States|US|U\.S\.|UK|United Kingdom|Canada|Germany)/g;
const STACK = W("react|next\\.?js|typescript|node\\.?js|nest\\.?js|graphql|electron|tailwind|redux|zustand|supabase|postgres(?:ql)?|openai|anthropic|llm|mcp|storybook|vite|websockets?");
const NEGATIVE = W("angular|vue(?:\\.js)?|svelte|\\.net|c#|java(?!script)|python|django|ruby|rails|golang|\\bgo\\b|php|laravel|symfony|scala|kotlin|flutter|react native|wordpress|shopify|drupal|magento|salesforce|sap|ui5|power platform|dynamics 365|elixir|rust|c\\+\\+");
const LANG = /(?:fluent|native|proficient|good|very good|communicative|business|advanced|c1|b2|working knowledge)[\s-]+(?:level\s+)?(?:of\s+|in\s+)?(german|french|italian|spanish|dutch|polish|portuguese|czech|swedish|norwegian|danish|finnish|japanese)|(german|french|italian|spanish|dutch|polish|portuguese|czech|swedish|norwegian|danish|finnish|japanese)(?:\s+language)?(?:\s+skills)?\s+(?:is\s+|are\s+)?(?:a\s+)?(?:required|mandatory|must|essential|necessary|needed)|(?:speak|speaking)\s+(german|french|italian|spanish|dutch|polish|portuguese)/gi;
const YEARS = /(\d{1,2})\s*\+?\s*(?:years|yrs|lat|years')\s+(?:of\s+)?(?:professional\s+|commercial\s+|hands-on\s+|proven\s+)?(?:experience|doświadczenia)/gi;
const SALARY = /(?:(?:PLN|zł|EUR|€|USD|\$|GBP|£)\s?\d[\d\s.,]{2,}(?:\s?[-–]\s?\d[\d\s.,]{2,})?(?:\s?(?:PLN|zł|EUR|USD|GBP))?|\d[\d\s.,]{2,}\s?(?:[-–]\s?\d[\d\s.,]{2,}\s?)?(?:PLN|zł|EUR|€|USD|GBP|£|k\b))(?:\s?(?:net|gross|brutto|netto))?(?:\s?\/?\s?(?:month|mo|year|yr|annual|h|hour|mies|m-c|rocznie|miesięcznie)(?![a-z]))?/gi;

/**
 * Whether a SALARY match is pay and not some other money in the text. It used
 * to put "$26", "$781" and "$500 h" into application rows: funding rounds
 * ("$26M Series A"), revenue, and "$500 hardware budget".
 */
function plausibleSalary(text, after) {
  if (/^\s?(?:m\b|mln|million|bn|b\b|billion|k\+? (?:users|customers|employees))/i.test(after)) return false;
  const thousands = /\d\s?k\b/i.test(text) ? 1000 : 1;
  const amounts = (text.match(/\d[\d\s.,]*/g) ?? []).map((n) => Number(n.replace(/[\s,]/g, "")) * thousands);
  const top = Math.max(0, ...amounts.filter((n) => Number.isFinite(n)));
  const hourly = /\/\s?h\b|\bh\b|hour|godz/i.test(text);
  return hourly ? top >= 20 : top >= 1000;
}
const LEVEL_JUNIOR = W("junior|intern|internship|trainee|graduate|entry[- ]level|młodszy");
const LEVEL_MID = W("mid|middle|regular|mid-level");
const LEVEL_SENIOR = W("senior|lead|staff|principal|expert|architect|starszy");

function uniq(matches, limit = 8) {
  const seen = new Map();
  for (const m of matches) {
    const key = m.toLowerCase().replace(/\s+/g, " ").trim();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, n]) => (n > 1 ? `${k}×${n}` : k));
}

export function analyse(title, text) {
  const body = text ?? "";
  const remote = body.match(REMOTE) ?? [];
  const hybrid = body.match(HYBRID) ?? [];
  const onsite = body.match(ONSITE) ?? [];
  let mode = "?";
  if (onsite.length) mode = "onsite";
  else if (hybrid.length) mode = remote.length > hybrid.length * 2 ? "remote?hybrid" : "hybrid";
  else if (remote.length) mode = "remote";
  // 70 characters of context around the first hybrid signal — enough to see "1 day a week".
  let hybridHint = "";
  if (hybrid[0]) {
    const at = body.toLowerCase().indexOf(hybrid[0].toLowerCase());
    hybridHint = ` «${body.slice(Math.max(0, at - 35), at + 40).replace(/\s+/g, " ").trim()}»`;
  }

  const locks = [];
  for (const m of body.matchAll(COUNTRY_LOCK)) {
    const place = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (place && !/^(The|This|Our|Your|A|An|Remote|Europe|EU|Poland|CET|EMEA)$/i.test(place)) locks.push(place);
  }

  const langs = [];
  for (const m of body.matchAll(LANG)) {
    const lang = (m[1] ?? m[2] ?? m[3] ?? "").toLowerCase();
    if (lang && lang !== "english") langs.push(lang);
  }

  const t = `${title ?? ""}`;
  const level = LEVEL_JUNIOR.test(t) ? "junior" : LEVEL_SENIOR.test(t) ? "senior" : LEVEL_MID.test(t) ? "mid" : "-";
  LEVEL_JUNIOR.lastIndex = LEVEL_SENIOR.lastIndex = LEVEL_MID.lastIndex = 0;

  const years = [...body.matchAll(YEARS)].map((m) => Number(m[1])).filter((n) => n > 0 && n < 20);
  const salary = uniq(
    [...body.matchAll(SALARY)]
      .filter((m) => plausibleSalary(m[0], body.slice(m.index + m[0].length, m.index + m[0].length + 14)))
      .map((m) => m[0].trim()),
    2,
  ).map((s) => s.replace(/\s+/g, " "));

  return {
    mode: mode + (mode.includes("hybrid") ? hybridHint : ""),
    lock: [...new Set(locks)].slice(0, 3),
    stack: uniq(body.match(STACK) ?? []),
    neg: uniq(body.match(NEGATIVE) ?? [], 6),
    lang: [...new Set(langs)],
    level,
    years: years.length ? Math.max(...years) : null,
    salary,
  };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[a.slice(2)] = next;
        i += 1;
      } else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

/**
 * What the screen (funnel.mjs screen --json) knew about the job, carried into
 * this row so the decision and apply-batch see it: Claude's verdict, the
 * screening flags (an earlier application, pay below the floor), the board's
 * own pay and dates. Without it the line was decided on the regexes below
 * alone, and apply-batch sent what Claude had called "skip".
 */
function carried(job) {
  return {
    bucket: job.bucket ?? null,
    screenReason: job.screenReason ?? job.reason ?? null,
    flags: job.flags ?? [],
    verdict: job.verdict ?? null,
    source: job.source ?? null,
    postedAt: job.postedAt ?? null,
    boardSalary: job.boardSalary ?? (typeof job.salary === "string" ? job.salary : null),
    pay: job.pay ?? null,
    belowSalaryFloor: Boolean(job.belowSalaryFloor),
    officeOk: Boolean(job.officeOk),
  };
}

async function fetchOne(job) {
  const started = Date.now();
  const resolved = await resolve(job.url);
  let posting = await readPosting(resolved);
  // Himalayas / LinkedIn point at the employer's ATS — read that too for the form.
  let applyVendor = posting.applyVendor ?? null;
  let applyUrl = posting.applyUrl ?? resolved;
  let applyPosting = null;
  if (!applyVendor && applyUrl && applyUrl !== resolved && !applyUrl.includes("#easy-apply")) {
    const applyResolved = await resolve(applyUrl);
    applyUrl = applyResolved;
    applyVendor = vendorOf(applyResolved);
    if (applyVendor !== "web" && applyVendor !== vendorOf(resolved)) {
      applyPosting = await readPosting(applyResolved);
      if (applyPosting?.text && applyPosting.text.length > (posting.text?.length ?? 0)) {
        posting = { ...posting, ...applyPosting, title: posting.title ?? applyPosting.title, company: posting.company ?? applyPosting.company };
      } else if (applyPosting?.questions) {
        posting.questions = applyPosting.questions;
      }
    }
  }
  if (!applyVendor) applyVendor = vendorOf(applyUrl);
  if (NEEDS_ACCOUNT.test(applyUrl) && applyVendor !== "linkedin-easy-apply") applyVendor = "portal";

  const title = job.title ?? posting.title?.replace(/\s[-|–]\s[^-|–]+$/, "");
  const company = job.company ?? posting.company ?? posting.title?.match(/\s[-|–]\s([^-|–]+)$/)?.[1]?.trim() ?? new URL(resolved).hostname.replace(/^(www|jobs|careers?|apply)\./, "").split(".")[0];
  const signals = analyse(title, posting.text);
  return {
    ...carried(job),
    index: job.index,
    company,
    title,
    url: job.url,
    finalUrl: resolved,
    vendor: posting.vendor,
    applyUrl,
    applyVendor,
    location: posting.location ?? job.location ?? null,
    closed: Boolean(posting.closed),
    error: posting.error ?? null,
    questions: posting.questions ?? null,
    text: posting.text ?? "",
    ...signals,
    ms: Date.now() - started,
  };
}

function formatLine(r) {
  const q = r.questions
    ? ` form:${r.questions.filter((x) => x.required).length}req` +
      (r.questions.filter((x) => x.required && !/name|email|phone|resume|cv|linkedin|location|consent|privacy|gdpr/i.test(x.label)).map((x) => `"${x.label.slice(0, 40)}"`).join(",") || "")
    : "";
  const v = r.verdict;
  const claude = v ? `claude:${v.verdict}/${v.score}${v.stale ? "(old)" : ""}${v.verdict === "skip" && v.hideReason ? ` «${v.hideReason}»` : ""}` : "claude:—";
  const marks = [r.belowSalaryFloor ? "!low-pay" : "", ...(r.flags ?? []).filter((flag) => /похоже на отклик/.test(flag)).map(() => "!applied-before")]
    .filter(Boolean)
    .join(" ");
  return [
    String(r.index ?? "-").padStart(3),
    `${r.company ?? "?"} — ${r.title ?? "?"}`.slice(0, 70),
    claude,
    marks,
    r.error ? `ERR ${r.error}` : r.closed ? "CLOSED" : r.mode,
    r.lock.length ? `lock:${r.lock.join("/")}` : "",
    r.level + (r.years ? `/${r.years}y` : ""),
    r.stack.length ? `+${r.stack.slice(0, 5).join(",")}` : "+none",
    r.neg.length ? `-${r.neg.join(",")}` : "",
    r.lang.length ? `lang:${r.lang.join(",")}` : "",
    // "pay:", not "$": the figure keeps its own currency.
    r.salary.length ? `pay:${r.salary[0]}` : "",
    `apply:${r.applyVendor}${q}`,
    r.applyUrl,
  ]
    .filter(Boolean)
    .join(" | ");
}

const { positional, flags } = parseArgs(process.argv.slice(2));
let jobs = [];
let previous = [];
if (flags.retry) {
  // Re-fetch only the rows that errored last time and merge them back.
  previous = JSON.parse(readFileSync(flags.retry, "utf8"));
  jobs = previous
    .filter((r) => r.error)
    .map((r) => ({ ...carried(r), index: r.index, url: r.url, title: r.title, company: r.company, location: r.location }));
  flags.out ??= flags.retry;
} else if (flags.screen) {
  const buckets = String(flags.buckets ?? "apply,check").split(",");
  jobs = JSON.parse(readFileSync(flags.screen, "utf8")).filter((r) => buckets.includes(r.bucket));
} else {
  jobs = positional.map((url, i) => ({ index: i, url }));
}
if (jobs.length === 0) {
  console.error("usage: jobs-fetch.mjs --screen screen.json [--buckets apply,check] [--out fetched.json] | <url>...");
  process.exit(1);
}

const results = [];
const CONCURRENCY = Number(flags.concurrency ?? 4);
let cursor = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      try {
        const r = await fetchOne(job);
        results.push(r);
        console.log(formatLine(r));
      } catch (error) {
        results.push({ ...job, ...carried(job), error: error.message, mode: "?", lock: [], stack: [], neg: [], lang: [], level: "-", salary: [], applyVendor: "?", applyUrl: job.url });
        console.log(`${String(job.index).padStart(3)} | ${job.company} — ${job.title} | ERR ${error.message}`);
      }
    }
  }),
);
const merged = previous.length ? previous.map((r) => results.find((n) => n.index === r.index) ?? r) : results;
merged.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
if (flags.out) writeFileSync(flags.out, JSON.stringify(merged, null, 2));
if (flags.text) for (const r of results) console.log(`\n===== ${r.company} — ${r.title}\n${r.text.slice(0, 6000)}`);
if (browserPromise) (await browserPromise).close();
process.exit(0);
