#!/usr/bin/env node
/**
 * apply.mjs — fill and submit one job application with Playwright on the
 * installed Chrome, then record it in the funnel. No screenshots reach the
 * model: the script prints a field→value map and one result line.
 *
 *   node scripts/apply.mjs <applyUrl> --url <postingUrl> --company ".." --title ".." [--source indeed]
 *                          [--cover <file|text>] [--answers <json file>] [--dry-run] [--headed]
 *   node scripts/apply.mjs --login            # opens a window on linkedin.com; log in, then close it
 *
 * Exit codes: 0 submitted (or dry run ok) · 2 required field has no answer
 * (the JSON on stdout lists them; put answers in --answers and re-run) ·
 * 3 submit failed (validation errors / no confirmation) · 4 needs an account
 * or a CAPTCHA — apply by hand.
 *
 * Answers come from .claude/skills/job-apply/profile.json via label rules in
 * answerFor(). A label that matches nothing is left empty when optional and
 * reported when required. The script never creates accounts, never types
 * passwords, never solves CAPTCHAs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { chromium } from "playwright";

const ROOT = resolvePath(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const PROFILE = JSON.parse(readFileSync(join(ROOT, ".claude/skills/job-apply/profile.json"), "utf8"));
// LinkedIn keeps its login in `chrome-profile` (see --login); every other board runs in a
// second profile so an open LinkedIn window never blocks an application elsewhere.
const USER_DATA = join(homedir(), ".job-hunt", "chrome-profile");
const USER_DATA_ATS = join(homedir(), ".job-hunt", "chrome-profile-ats");
const SHOTS = join(homedir(), ".job-hunt", "shots");
const DASHBOARD = (process.env["JOBHUNT_URL"] ?? "http://localhost:4321").replace(/\/$/, "");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/* ------------------------------------------------------------------ */
/* Args                                                                */
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

const { positional, flags } = parseArgs(process.argv.slice(2));
const log = (...parts) => console.error(...parts);
const DEBUG = Boolean(process.env["JH_DEBUG"]) || Boolean(flags.debug);

/* ------------------------------------------------------------------ */
/* Answer rules                                                        */
/* ------------------------------------------------------------------ */

const NON_PL_COUNTRIES = /united states|\bus\b|u\.s\.|usa|united kingdom|\buk\b|britain|canada|germany|netherlands|france|spain|italy|sweden|denmark|norway|finland|ireland|switzerland|austria|belgium|portugal|australia|israel|india|uae|dubai|singapore|japan/i;

function salaryFor(label, type) {
  const l = label.toLowerCase();
  const hourly = /hour|\/h\b|hourly|stawka godz/.test(l);
  const yearly = /year|annual|yearly|rocz/.test(l);
  const usd = /usd|\$|dollar/.test(l);
  const eur = /eur|€/.test(l);
  // A question ("What compensation are you targeting?") gets a sentence in the currency it names;
  // a bare "Desired salary" box next to a currency/period select gets the number.
  if (type !== "number" && (type === "textarea" || /\?|describe|comment|explain|what |expectation/.test(l))) {
    if (/day rate|daily rate|per day|dzienn/.test(l)) {
      if (usd) return `$${Math.round(PROFILE.salary.usdMonthly / 21)} / day gross (B2B), ≈ $${PROFILE.salary.usdMonthly.toLocaleString("en-US")} / month; open to discussion`;
      if (eur) return `€${Math.round(PROFILE.salary.eurMonthly / 21)} / day gross (B2B), ≈ €${PROFILE.salary.eurMonthly.toLocaleString("en-US")} / month; open to discussion`;
      return `≈ ${Math.round(PROFILE.salary.plnMonthlyB2B / 21).toLocaleString("en-US")} PLN / day net (B2B), i.e. ${PROFILE.salary.plnMonthlyB2BRange}; open to discussion`;
    }
    if (usd) return `$${PROFILE.salary.usdMonthly.toLocaleString("en-US")} / month gross (B2B), ≈ $${Math.round(PROFILE.salary.usdYearly / 1000)}k / year; open to discussion depending on scope`;
    if (eur) return `€${PROFILE.salary.eurMonthly.toLocaleString("en-US")} / month gross (B2B), ≈ €${Math.round(PROFILE.salary.eurYearly / 1000)}k / year; open to discussion depending on scope`;
    return PROFILE.salary.text;
  }
  if (usd) return String(hourly ? 45 : yearly ? PROFILE.salary.usdYearly : PROFILE.salary.usdMonthly);
  if (eur) return String(hourly ? 42 : yearly ? PROFILE.salary.eurYearly : PROFILE.salary.eurMonthly);
  return String(hourly ? 170 : yearly ? PROFILE.salary.plnMonthlyB2B * 12 : PROFILE.salary.plnMonthlyB2B);
}

function yearsFor(label) {
  const l = label.toLowerCase();
  if (/react native/.test(l)) return "0";
  if (/next/.test(l)) return String(PROFILE.yearsNext);
  if (/react/.test(l)) return String(PROFILE.yearsReact);
  if (/typescript/.test(l)) return String(PROFILE.yearsTypescript);
  if (/node|nest|backend|back-end/.test(l)) return String(PROFILE.yearsNode);
  if (/llm|ai|openai|anthropic|genai|prompt/.test(l)) return "3";
  if (/lead|leadership|manag/.test(l)) return "2";
  if (/angular|vue|\.net|java\b|python|php|c#|golang|mobile|ios|android|flutter/.test(l)) return "0";
  return String(PROFILE.yearsExperience);
}

/**
 * The answer for a control, from its label. `kind` says how to apply it:
 *   text   → fill / type
 *   select → pick the option whose text matches any of `prefer` (regex list)
 *   check  → tick the checkbox
 *   file   → upload the CV
 *   skip   → leave empty on purpose (optional demographic data etc.)
 */
function answerFor(label, control, extra) {
  const l = label.toLowerCase().replace(/\s+/g, " ");
  const { type, tag } = control;
  const isChoice = tag === "select" || type === "radio" || control.role === "combobox" || control.role === "listbox";

  // User-supplied overrides win: --answers { "label substring": "value" }.
  for (const [key, value] of Object.entries(extra)) {
    if (l.includes(key.toLowerCase())) {
      if (isChoice) {
        const prefer = String(value).split("|").map((v) => new RegExp(escape(v.trim()), "i"));
        if (/^yes$/i.test(value)) prefer.push(/agree|accept|consent|confirm/i);
        return { kind: "select", prefer };
      }
      if (type === "checkbox") return { kind: /^(yes|true|1|on)$/i.test(value) ? "check" : "skip" };
      return { kind: "text", value };
    }
  }

  if (type === "file") return /cover|list motywacyjny|portfolio|other|additional/.test(l) && !/resume|cv|curriculum/.test(l) ? { kind: "skip" } : { kind: "file" };

  // Consent phrased as a question with a Yes/No dropdown or radio.
  if (isChoice && /consent|privacy|gdpr|rodo|agree|accept|acknowledge|terms|policy|zgod|regulamin|processing|i have read|i.?m ok with|i confirm/.test(l) && !/sponsor|visa|relocat/.test(l)) {
    return { kind: "select", prefer: [/^yes\b/i, /agree|accept|consent|confirm/i, /^tak\b/i] };
  }

  if (type === "checkbox") {
    if (/newsletter|marketing|future (roles|opportunities|positions)|talent pool|other recruitment|keep my (data|cv)|further recruitment|przyszł|kolejn/.test(l)) return control.required ? { kind: "check" } : { kind: "skip" };
    if (/consent|privacy|gdpr|rodo|agree|accept|acknowledge|terms|policy|zgod|regulamin|wyrażam|oświadczam|i have read|processing|i.?m ok with|i am ok with|i confirm|i authori[sz]e|i allow|permission to/.test(l)) return { kind: "check" };
    if (/follow/.test(l)) return { kind: "skip" };
    return control.required ? { kind: "check" } : null;
  }

  if (/first ?name|given name|^imię$|forename/.test(l)) return { kind: "text", value: PROFILE.firstName };
  if (/last ?name|surname|family name|nazwisko/.test(l)) return { kind: "text", value: PROFILE.lastName };
  if (/^(your )?(full )?name\*?$|full name|imię i nazwisko|your name|candidate name|^name$/.test(l)) return { kind: "text", value: PROFILE.fullName };
  if (/e[\s-]*mail|adres e/.test(l)) return isChoice ? { kind: "select", prefer: [new RegExp(escape(PROFILE.email), "i"), /@/] } : { kind: "text", value: PROFILE.email };
  if (/country code|kod kraju|dial code|phone code/.test(l)) return isChoice ? { kind: "select", prefer: [/poland.*\+48|\+48.*poland/i, /\+48\b/, /poland/i] } : { kind: "text", value: "+48" };
  // Polish boards (traffit, eRecruiter): kraj / miasto / obszar technologiczny / rola.
  if (/\bkraj\b/.test(l)) return isChoice ? { kind: "select", prefer: [/^polska$/i, /polska|poland/i] } : { kind: "text", value: "Polska" };
  if (/\bmiasto\b|miejscowość/.test(l)) return isChoice ? { kind: "select", prefer: [/warszawa|warsaw/i, /polska/i] } : { kind: "text", value: "Warszawa" };
  if (/obszar technolog|technology area|specjalizacja/.test(l)) return isChoice ? { kind: "select", prefer: [/front[- ]?end/i, /full[- ]?stack/i, /javascript|\bjs\b|typescript/i, /\bweb\b/i] } : { kind: "text", value: "Frontend / Fullstack (React, TypeScript, Node.js)" };
  if (/rola projektow|project role|stanowisko/.test(l)) return isChoice ? { kind: "select", prefer: [/^front[- ]?end( developer| engineer)?$/i, /front[- ]?end/i, /full[- ]?stack/i, /senior.*(front|full|developer|engineer)/i, /developer|programista/i] } : { kind: "text", value: PROFILE.currentTitle };
  if (/phone|telefon|mobile|tel\b/.test(l)) return { kind: "text", value: PROFILE.phone };
  if (/linkedin/.test(l)) return { kind: "text", value: PROFILE.linkedin };
  if (/github/.test(l)) return { kind: "text", value: PROFILE.github };
  if (/portfolio|website|personal (site|page)|homepage|^url|^link|online profile/.test(l)) return { kind: "text", value: PROFILE.portfolio };
  if (/resume|\bcv\b|curriculum/.test(l) && type !== "file") return { kind: "skip" };

  if (/country of residence|^country|kraj|country.*(reside|live|located|based)|which country/.test(l)) return isChoice ? { kind: "select", prefer: [/^poland$/i, /poland/i, /polska/i] } : { kind: "text", value: PROFILE.country };
  if (/city|town|location|where (are you|do you|will you be|would you be) (based|live|reside|living|working|work)|working from|work from|address|miasto|lokalizacja|miejsce zamieszkania|based in|current location/.test(l)) {
    return isChoice ? { kind: "select", prefer: [/warsaw/i, /warszawa/i, /poland/i, /remote/i] } : { kind: "text", value: PROFILE.location, autocomplete: true };
  }
  if (/current (company|employer)|^company|employer|organi[sz]ation|firma/.test(l) && !/why|about|notice|leav|sponsor/.test(l)) return { kind: "text", value: PROFILE.currentCompany };
  if (/current (title|role|position|job)|job title|headline|stanowisko/.test(l)) return { kind: "text", value: PROFILE.currentTitle };
  if (/pronoun/.test(l)) return { kind: "skip" };
  if (/date of birth|birth|^age$|wiek/.test(l)) return null;
  if (/gender|sex\b|płeć|race|ethnic|veteran|disabilit|orientation|religion|transgender|identify as/.test(l)) {
    return isChoice ? { kind: "select", prefer: [/decline|prefer not|do not wish|rather not|choose not|nie chcę/i] } : { kind: "skip" };
  }

  if (/salary|compensation|remuneration|wynagrodzen|stawk|expected (pay|rate|income)|pay expectation|rate expectation|expected rate|daily rate|hourly rate|monthly rate|financial expectation|oczekiwan/.test(l)) {
    const opts = (control.options ?? []).join(" | ");
    if (isChoice && /dollar|euro|zloty|złoty|pln|usd/i.test(opts)) return { kind: "select", prefer: [/polish|pln|zł/i, /^us dollar|usd/i, /euro|eur/i] };
    if (isChoice && /monthly|yearly|hourly/i.test(opts)) return { kind: "select", prefer: [/monthly/i, /yearly|annual/i] };
    return isChoice ? { kind: "select", prefer: [/25|27|28|30/i, /20/] } : { kind: "text", value: salaryFor(l, type) };
  }
  if (/notice period|okres wypowiedzenia|availability|available (from|to start)|start date|earliest|when (can|could) you start|kiedy|how soon|how much notice|notice (you )?(must|need|have to)|dostępność/.test(l)) {
    if (type === "date") return { kind: "text", value: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10) };
    return isChoice ? { kind: "select", prefer: [/2 weeks|two weeks|14 days|2 tygodnie/i, /immediately|asap|right away|now|natychmiast/i, /1 month|one month|30 days|1 miesiąc|30 dni/i, /less than/i] } : { kind: "text", value: PROFILE.noticePeriod };
  }
  if (/years? (of )?(professional |commercial |relevant |work )?(experience|exp)|how many years|lat doświadczenia|experience \(years\)/.test(l)) {
    const years = yearsFor(l);
    return isChoice ? { kind: "select", prefer: [new RegExp(`^${years}\\b`), /5\s*\+|more than 5|5-10|6-10|7-10|8\+|10\+/i, /\+/] } : { kind: "text", value: years };
  }
  if (/english|angielsk/.test(l) && /level|proficien|fluen|knowledge|język|skill|znajomo/.test(l)) {
    return isChoice ? { kind: "select", prefer: [/c1/i, /advanced|zaawansowan/i, /fluent|biegł/i, /proficient/i, /professional/i, /upper/i, /b2/i] } : { kind: "text", value: "C1 (advanced, daily working language)" };
  }
  if (/polish|polsk/.test(l) && /level|proficien|fluen|knowledge|język|skill|speak|znajomo/.test(l)) {
    return isChoice ? { kind: "select", prefer: [/b1/i, /intermediate|komunikatywn/i, /basic|communicative|podstawow/i, /conversational/i] } : { kind: "text", value: "B1 (communicative)" };
  }
  if (/which languages|languages (you )?speak|language skills|znajomość języków/.test(l)) return isChoice ? { kind: "select", prefer: [/english/i] } : { kind: "text", value: "English (C1), Polish (B1), Russian (native)" };
  if (/nationality|citizenship|obywatelstwo/.test(l)) return isChoice ? { kind: "select", prefer: [/belarus/i] } : { kind: "text", value: PROFILE.nationality };

  if (/sponsor|visa/.test(l)) {
    if (/poland|polsk|\beu\b|europe/.test(l) && !NON_PL_COUNTRIES.test(l)) return { kind: "select", prefer: [/^no\b/i, /not required|don't|do not/i] };
    if (NON_PL_COUNTRIES.test(l)) return { kind: "select", prefer: [/^yes\b/i] };
    return { kind: "select", prefer: [/^no\b/i] };
  }
  if (/authori[sz]ed|legally|right to work|eligible to work|permit|allowed to work|work (in|from) (poland|the eu)|pozwolenie|legal(ly)? (able|entitled)|country you are in|country you live in|country of residence/.test(l)) {
    if (NON_PL_COUNTRIES.test(l) && !/poland|polsk/.test(l)) return { kind: "select", prefer: [/^no\b/i] };
    return { kind: "select", prefer: [/^yes\b/i, /poland/i, /eu citizen|eu work permit|valid work permit|permit/i] };
  }
  if (/relocat|przeprowadz/.test(l)) return { kind: "select", prefer: [/^no\b/i, /not willing/i] };
  if (/work remotely|remote work|working remotely|comfortable (with )?remote|fully remote/.test(l)) return { kind: "select", prefer: [/^yes\b/i] };
  if (/previously (worked|applied|employed)|have you (ever )?(applied|worked|been employed)|former employee|wcześniej/.test(l)) return { kind: "select", prefer: [/^no\b/i] };
  if (/have you used|used (a|our|any) .*product|customer of|current(ly)? (a )?(customer|user)/.test(l)) return { kind: "select", prefer: [/^no\b/i] };
  if (/currently (employed|working)|are you employed/.test(l)) return { kind: "select", prefer: [/^yes\b/i] };
  if (/how did you (hear|find|learn)|where did you (hear|find)|source|skąd/.test(l)) return isChoice ? { kind: "select", prefer: [/job board/i, /linkedin/i, /indeed/i, /other/i, /internet|online|search/i] } : { kind: "text", value: PROFILE.heardFrom };
  if (/contract|employment type|form of (cooperation|employment|collaboration)|umow|b2b|cooperation model|rodzaj umowy/.test(l)) {
    return isChoice ? { kind: "select", prefer: [/umowa o prac|employment contract|permanent|full[- ]time employee|uop/i, /b2b|contract/i, /either|any|no preference|both/i] } : { kind: "text", value: PROFILE.contractPreference.join(" or ") };
  }
  if (/seniority|level of experience|experience level|your level/.test(l)) return isChoice ? { kind: "select", prefer: [/senior/i, /lead/i, /expert/i] } : { kind: "text", value: "Senior" };
  if (/education|degree|wykształcenie|highest level/.test(l)) return isChoice ? { kind: "select", prefer: [/master/i, /graduate/i, /university|higher/i] } : { kind: "text", value: PROFILE.education.degree };
  if (/school|university|uczelnia/.test(l)) return { kind: "text", value: PROFILE.education.school };
  if (/cover letter|motivation|list motywacyjny|message to|why (do you want|are you interested|this role|us)|tell us (about|why)|additional (information|comments|notes)|anything else|introduce yourself|about yourself|comments|note to|^enter manually$/.test(l)) {
    return tag === "textarea" || control.contenteditable ? { kind: "text", value: extra.__cover ?? "" } : type === "file" ? { kind: "skip" } : null;
  }
  if (/consent|privacy|gdpr|rodo|i.?m ok with|i agree|i confirm|processing my/.test(l) && !/sponsor|visa|relocat/.test(l)) {
    return isChoice ? { kind: "select", prefer: [/^yes\b/i, /agree|accept|consent|confirm/i] } : { kind: "text", value: "Yes" };
  }
  if (/full[- ]time|part[- ]time|hours per week|availability per week/.test(l)) return isChoice ? { kind: "select", prefer: [/full/i, /40/] } : { kind: "text", value: "Full-time (40h/week)" };
  if (/timezone|time zone/.test(l)) return isChoice ? { kind: "select", prefer: [/warsaw/i, /cet|central european/i, /utc\+1|gmt\+1/i] } : { kind: "text", value: "CET (Europe/Warsaw)" };
  if (/overlap|working hours/.test(l)) return { kind: "text", value: "CET; comfortable overlapping with US East Coast mornings and all EU hours" };
  if (/travel/.test(l)) return isChoice ? { kind: "select", prefer: [/occasional|yes|up to 10|some/i] } : { kind: "text", value: "Occasionally, for team meetups" };
  return null;
}

function escape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Four short paragraphs; `stack` is the comma list jobs-fetch found in the posting. */
function autoCover(company, title, stack) {
  const s = stack.toLowerCase();
  const extras = [];
  if (/llm|openai|anthropic|mcp|\bai\b/.test(s)) extras.push("I also integrate LLMs into products: an Anthropic/OpenAI pipeline with prompt versioning, structured outputs and streaming, plus a custom MCP server that automates our team's delivery pipeline from Jira ticket to CI run.");
  if (/graphql/.test(s)) extras.push("GraphQL is daily work for me: I built a Google Maps event explorer with GraphQL-driven data and marker clustering in Next.js.");
  if (/electron/.test(s)) extras.push("On the desktop side I ship and maintain a commercial Electron + React Steam game solo (29K lines of TypeScript, 450+ tests).");
  if (/next/.test(s) && extras.length < 2) extras.push("I run a production Next.js + Supabase SaaS of my own (stashlootstack.com), including Stripe billing and scheduled data syncs.");
  if (/accessib|wcag|a11y/.test(s)) extras.push("Accessibility is part of how I build: WCAG 2.1 AA / RGAA-compliant, server-rendered UIs for Qobuz.com across all regional domains.");
  return [
    `Hi ${company} team,`,
    `I'm a senior software engineer (9 years; React, Next.js, TypeScript, Node.js/NestJS) based in Warsaw and working fully remote. Most recently I've been building Next.js/GraphQL modules for a B2B events platform and SSR components for Qobuz.com; before that I was tech lead on an AI product, where I led the migration from Firebase to NestJS and cut LLM response times from 10-15 s to ~3 s.`,
    ...extras.slice(0, 2),
    `I'd be glad to talk about the ${title} role. My CV is attached; portfolio: ${PROFILE.portfolio}.`,
    `Best regards,\nAnton Perch\n${PROFILE.phone} · ${PROFILE.linkedin}`,
  ].join("\n\n");
}

/* ------------------------------------------------------------------ */
/* DOM scan — runs in the page                                         */
/* ------------------------------------------------------------------ */

const SCAN = `(scopeSelector) => {
  const scope = scopeSelector ? document.querySelector(scopeSelector) : document;
  if (!scope) return [];
  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && (r.width > 0 || r.height > 0 || el.type === "file");
  };
  const textOf = (el) => clean(el ? el.innerText || el.textContent : "");
  const fileLabelOf = (el) => {
    let p = el.parentElement;
    for (let i = 0; i < 7 && p && p !== scope; i += 1) {
      const t = clean(p.innerText).slice(0, 300);
      if (/resume|\bcv\b|curriculum|cover letter|list motywacyjny|portfolio|attachment|załącz/i.test(t)) return t.slice(0, 120);
      p = p.parentElement;
    }
    return "";
  };
  const labelOf = (el) => {
    let t = "";
    if ((el.getAttribute("type") || "").toLowerCase() === "file") t = fileLabelOf(el);
    if (!t && el.id) { try { const l = scope.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) t = textOf(l); } catch {} }
    if (!t) { const l = el.closest("label"); if (l) t = textOf(l); }
    if (!t && el.getAttribute("aria-labelledby")) t = el.getAttribute("aria-labelledby").split(/\\s+/).map((i) => textOf(document.getElementById(i))).join(" ");
    if (!t) t = clean(el.getAttribute("aria-label"));
    if (!t && el.getAttribute("data-qa")) t = clean(el.getAttribute("data-qa"));
    // A placeholder names the field better than a section heading two levels up.
    if (!t && el.placeholder) t = clean(el.placeholder);
    if (!t && el.tagName === "TEXTAREA") {
      let p = el.parentElement;
      for (let i = 0; i < 6 && p && p !== scope; i += 1) {
        const head = clean(p.innerText).slice(0, 160);
        if (/cover letter|list motywacyjny|motivation|message|additional information/i.test(head)) { t = head.slice(0, 80); break; }
        p = p.parentElement;
      }
    }
    if (!t) {
      let p = el.parentElement;
      for (let i = 0; i < 5 && p && p !== scope; i += 1) {
        const lab = p.querySelector("label, legend, [class*=label i], [class*=question i], h1, h2, h3, h4, h5, p, span");
        if (lab && !lab.contains(el) && clean(lab.innerText)) { t = clean(lab.innerText); break; }
        p = p.parentElement;
      }
    }
    if (!t) t = clean(el.placeholder) || clean(el.name) || clean(el.id);
    return t.slice(0, 200);
  };
  const groupLabelOf = (el) => {
    const entry = el.closest(".ashby-application-form-field-entry, [data-field-path]");
    if (entry) { const l = entry.querySelector("label"); if (l && clean(l.innerText)) return clean(l.innerText); }
    const fs = el.closest("fieldset");
    if (fs) { const lg = fs.querySelector("legend"); if (lg) return textOf(lg); }
    let p = el.parentElement;
    for (let i = 0; i < 6 && p && p !== scope; i += 1) {
      const radios = p.querySelectorAll('input[type=radio], [role=radio]');
      if (radios.length >= 2) {
        const head = p.querySelector("legend, label:not(:has(input)), [class*=label i], [class*=question i], h3, h4, p, span");
        if (head && clean(head.innerText) && !head.querySelector("input")) return clean(head.innerText);
      }
      p = p.parentElement;
    }
    return "";
  };
  const controls = [...scope.querySelectorAll("input, select, textarea, [role=combobox], [role=listbox], [contenteditable=true], [role=radio], [role=checkbox], button[aria-pressed][data-option], button[aria-pressed][role=radio]")];
  const out = [];
  let n = 0;
  for (const el of controls) {
    const pressed = el.tagName === "BUTTON" && el.hasAttribute("aria-pressed");
    const type = pressed ? "radio" : (el.getAttribute("type") || (el.tagName === "SELECT" ? "select" : el.tagName === "TEXTAREA" ? "textarea" : el.getAttribute("role") || "text")).toLowerCase();
    // react-select and friends: a plain text input that really is a dropdown.
    const combo = el.getAttribute("role") === "combobox" || !!el.closest("[role=combobox]") || el.getAttribute("aria-autocomplete") === "list" || el.getAttribute("aria-haspopup") === "listbox" || /select/i.test(el.className) || /select/i.test(el.parentElement?.className || "");
    const role = pressed ? "radio" : combo && el.tagName === "INPUT" ? "combobox" : (el.getAttribute("role") || "");
    if (["hidden", "submit", "button", "reset", "image", "search"].includes(type)) continue;
    // A combobox container that wraps a real input: the input is the control, not the wrapper.
    if (!["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) && el.querySelector("input, select, textarea")) continue;
    if (!visible(el) && type !== "file" && type !== "radio" && type !== "checkbox") continue;
    if (el.disabled || el.readOnly) continue;
    // react-select keeps a hidden "required" mirror input next to the real one; skip helpers like it.
    if (el.getAttribute("aria-hidden") === "true") continue;
    if (el.getAttribute("tabindex") === "-1" && !["file", "radio", "checkbox"].includes(type) && el.getAttribute("role") !== "radio") continue;
    el.setAttribute("data-jh", String(n));
    const requiredMark = (el.required || el.getAttribute("aria-required") === "true");
    let label = type === "radio" || el.getAttribute("role") === "radio" ? groupLabelOf(el) : labelOf(el);
    const optionLabel = pressed ? clean(el.innerText) : type === "radio" || el.getAttribute("role") === "radio" ? labelOf(el) : "";
    const required = requiredMark || /\\*\\s*$|\\(required\\)|^\\*|required/i.test(label);
    const options = el.tagName === "SELECT" ? [...el.options].map((o) => clean(o.textContent)).filter(Boolean).slice(0, 400) : [];
    out.push({ idx: n, tag: el.tagName.toLowerCase(), type, role, name: el.name || (pressed ? (el.closest("[data-field-path]")?.getAttribute("data-field-path") || label) : ""), id: el.id || "", label, optionLabel, required, options, checked: !!el.checked || el.getAttribute("aria-pressed") === "true", value: el.value || "", contenteditable: el.getAttribute("contenteditable") === "true" });
    n += 1;
  }
  return out;
}`;

/* ------------------------------------------------------------------ */
/* Filling                                                             */
/* ------------------------------------------------------------------ */

// A string in page.evaluate is an expression, not a call — turn it into a real function first.
const scanControls = new Function(`return (${SCAN})`)();

let keys = null; // the Page whose keyboard/mouse we drive, even when filling inside an iframe

async function fillControls(page, scopeSelector, extra, report) {
  if (DEBUG) {
    const all = await page.evaluate(scanControls, scopeSelector ?? null);
    log(`  [scan] ${all.length} controls: ` + all.map((c) => `${c.tag}/${c.type}${c.required ? "*" : ""} "${(c.label || c.optionLabel || c.name).slice(0, 35)}"`).join(" · "));
  }
  // Greenhouse hides the cover-letter textarea behind "Enter manually" (one button per
  // attachment field, so this runs after the CV is attached and only the cover one is left).
  if (extra.__cover) {
    const manual = page.locator('button:has-text("Enter manually"):visible');
    const count = await manual.count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const sectionText = await manual.nth(i).evaluate((b) => {
        let p = b.parentElement;
        for (let k = 0; k < 5 && p; k += 1) { if (/cover letter|resume/i.test(p.innerText ?? "")) return p.innerText.slice(0, 120); p = p.parentElement; }
        return "";
      }).catch(() => "");
      if (/cover/i.test(sectionText) && !/resume/i.test(sectionText.split("\n")[0] ?? "")) { await manual.nth(i).click().catch(() => {}); await page.waitForTimeout(600); break; }
    }
  }
  const controls = await page.evaluate(scanControls, scopeSelector ?? null);
  const scope = scopeSelector ? page.locator(scopeSelector) : page;
  const missing = [];
  const radioGroupsDone = new Set();

  for (const c of controls) {
    const loc = scope.locator(`[data-jh="${c.idx}"]`).first();
    const label = c.label || c.optionLabel;
    const answer = answerFor(label, c, extra);
    const note = (what) => report.push(`${label.slice(0, 50) || c.name || c.id} ← ${what}`);

    if (c.type === "radio" || c.role === "radio") {
      const key = c.name || c.label;
      if (radioGroupsDone.has(key)) continue;
      const group = controls.filter((x) => (x.type === "radio" || x.role === "radio") && (x.name || x.label) === key);
      const preferred = answer?.kind === "select" ? answer.prefer : null;
      let pickIdx = null;
      if (preferred) {
        for (const re of preferred) {
          const hit = group.find((x) => re.test(x.optionLabel));
          if (hit) { pickIdx = hit.idx; break; }
        }
      }
      if (pickIdx === null && group.every((x) => !x.checked)) {
        missing.push({ label: c.label, type: "radio", options: group.map((x) => x.optionLabel) });
      } else if (pickIdx !== null) {
        await scope.locator(`[data-jh="${pickIdx}"]`).first().click({ force: true }).catch(() => {});
        note(group.find((x) => x.idx === pickIdx).optionLabel);
      }
      radioGroupsDone.add(key);
      continue;
    }

    if (!answer) {
      if (c.required && !c.value && !c.checked) missing.push({ label, type: c.type, options: c.options.slice(0, 15) });
      continue;
    }
    if (answer.kind === "skip") continue;

    try {
      if (answer.kind === "file") {
        if (report.some((r) => r.endsWith("← CV"))) continue; // second pass: already attached
        await loc.setInputFiles(PROFILE.cvPath);
        note("CV");
        // Boards that parse the CV (Breezy, SmartRecruiters, Teamtailor) prefill fields a few seconds later.
        await page.waitForTimeout(/breezy|smartrecruiters|teamtailor|\/jobs\/\d+/.test(page.url()) ? 7000 : 1500);
      } else if (answer.kind === "check") {
        if (c.checked) continue;
        if (c.role === "checkbox") await loc.click({ force: true });
        else {
          await loc.check({ force: true, timeout: 4000 }).catch(async () => {
            // Styled checkbox with a hidden input: the label is the click target.
            const byFor = c.id ? scope.locator(`label[for="${c.id.replace(/"/g, '\\"')}"]`).first() : null;
            if (byFor && (await byFor.count().catch(() => 0))) await byFor.click({ force: true });
            else await loc.evaluate((el) => { el.checked = true; el.dispatchEvent(new Event("change", { bubbles: true })); el.dispatchEvent(new Event("input", { bubbles: true })); });
          });
        }
        note("☑");
      } else if (answer.kind === "select") {
        if (/-selectized$/.test(c.id)) {
          const pickSelectize = ([inputId, patterns]) => {
            const select = document.getElementById(inputId.replace(/-selectized$/, ""));
            if (!select || select.tagName !== "SELECT") return null;
            const api = select.selectize ?? (window.jQuery && window.jQuery(select)[0]?.selectize);
            const pool = api
              ? Object.values(api.options).map((o) => ({ value: String(o[api.settings.valueField ?? "value"]), text: String(o[api.settings.labelField ?? "text"] ?? o.text ?? "") }))
              : [...select.options].map((o) => ({ value: o.value, text: o.textContent.trim() }));
            for (const src of patterns) {
              const re = new RegExp(src, "i");
              const hit = pool.find((o) => o.value !== "" && re.test(o.text.trim()));
              if (hit) {
                if (api) api.setValue(hit.value);
                else { select.value = hit.value; select.dispatchEvent(new Event("change", { bubbles: true })); }
                return hit.text.trim();
              }
            }
            return null;
          };
          let picked = await page.evaluate(pickSelectize, [c.id, answer.prefer.map((r) => r.source)]);
          if (!picked) {
            // Options loaded on demand (cities): type the first preference, let the widget search, retry.
            const word = (answer.kind === "select" ? answer.prefer[0].source : "").replace(/\\[a-zA-Z]/g, " ").replace(/[^a-zA-Z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ ]/g, " ").trim().split(/\s+/)[0] ?? "";
            if (word) {
              await loc.click({ force: true }).catch(() => {});
              await keys.keyboard.type(word, { delay: 30 });
              await page.waitForTimeout(1800);
              picked = await page.evaluate(pickSelectize, [c.id, answer.prefer.map((r) => r.source)]);
              if (!picked) await keys.keyboard.press("Escape");
            }
          }
          if (picked) { note(picked.slice(0, 40)); continue; }
          if (c.required) missing.push({ label, type: "selectize" });
          continue;
        }
        if (c.tag === "select") {
          let chosen = null;
          for (const re of answer.prefer) {
            chosen = c.options.find((o) => re.test(o));
            if (chosen) break;
          }
          if (!chosen) { if (c.required) missing.push({ label, type: "select", options: c.options.slice(0, 15) }); continue; }
          await loc.selectOption({ label: chosen });
          note(chosen);
        } else {
          // react-select style combobox: open, type the first preference, pick the matching option.
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          await loc.click({ force: true, timeout: 5000 }).catch(async () => { await loc.focus().catch(() => {}); });
          // Only options that are actually on screen: other dropdowns keep their lists in the DOM.
          const options = page.locator('[role="option"]:visible, [class*="__option" i]:visible, [class*="-option" i]:visible, li[class*="option" i]:visible, .selectize-dropdown .option:visible, .dropdown-menu li:visible, .autocomplete-item:visible');
          const readOptions = async () => (await options.allInnerTexts().catch(() => [])).filter((t) => !/^no options$/i.test(t.trim()));
          let texts = [];
          for (let attempt = 0; attempt < 3 && texts.length === 0; attempt += 1) {
            await page.waitForTimeout(500);
            texts = await readOptions();
            if (DEBUG) log(`  [combobox] "${label.slice(0, 40)}" attempt ${attempt}: located=${await loc.count()} expanded=${await loc.getAttribute("aria-expanded").catch(() => "?")} options=${JSON.stringify(texts.slice(0, 5))}`);
            if (texts.length) break;
            if (attempt === 0) await keys.keyboard.press("ArrowDown");
            if (attempt === 1) await loc.locator("xpath=ancestor::*[3]//button").first().click({ force: true, timeout: 2000 }).catch(() => {});
          }
          // The first word of the first preference, with regex syntax (\b, ^, |, …) stripped out.
          const typed = answer.prefer[0].source.replace(/\\[a-zA-Z]/g, " ").replace(/[^a-zA-Z0-9 ]/g, " ").trim().split(/\s+/)[0] ?? "";
          const alreadyListed = answer.prefer.some((re) => texts.some((t) => re.test(t.trim())));
          if (typed && !/^(yes|no|tak|nie)$/i.test(typed) && !alreadyListed) {
            await keys.keyboard.type(typed, { delay: 20 });
            await page.waitForTimeout(900);
            texts = await readOptions();
            if (!texts.some((t) => t.trim())) { await page.waitForTimeout(1200); texts = await readOptions(); }
            texts = texts.filter((t) => t.trim());
          }
          let chosenIdx = -1;
          for (const re of answer.prefer) {
            chosenIdx = texts.findIndex((t) => re.test(t.trim()));
            if (chosenIdx >= 0) break;
          }
          if (DEBUG) log(`  [combobox] decide "${label.slice(0, 30)}": typed=${JSON.stringify(typed)} listed=${alreadyListed} texts=${JSON.stringify(texts.slice(0, 4))} chosen=${chosenIdx} prefer=${answer.prefer.map((r) => r.source).join(" ; ")}`);
          if (chosenIdx >= 0) { await options.nth(chosenIdx).click({ force: true }); note(texts[chosenIdx].trim().slice(0, 40)); }
          else if (texts.length === 0 && typed) { await keys.keyboard.press("Enter"); note(`⏎ ${typed}`); }
          else { await keys.keyboard.press("Escape"); if (c.required) missing.push({ label, type: "combobox", options: texts.map((t) => t.trim()).slice(0, 15) }); }
        }
      } else if (answer.kind === "text") {
        if (!answer.value) { if (c.required) missing.push({ label, type: c.type }); continue; }
        if (c.contenteditable) { await loc.click(); await keys.keyboard.type(answer.value); }
        else if (c.role === "combobox" || answer.autocomplete) {
          await loc.click();
          await loc.fill("");
          await keys.keyboard.type(answer.value.split(",")[0], { delay: 25 });
          await page.waitForTimeout(900);
          const option = page.locator('[role="option"], [class*="suggestion" i], [class*="autocomplete" i] li, .pac-item').first();
          if (await option.isVisible().catch(() => false)) await option.click();
          else await keys.keyboard.press("Escape");
        } else {
          await loc.fill(answer.value);
        }
        note(answer.value.length > 40 ? answer.value.slice(0, 37) + "…" : answer.value);
      }
    } catch (error) {
      report.push(`${label.slice(0, 50)} ✗ ${error.message.split("\n")[0].slice(0, 80)}`);
      if (c.required) missing.push({ label, type: c.type, error: error.message.split("\n")[0] });
    }
  }
  return missing;
}

/* ------------------------------------------------------------------ */
/* Vendor entry points                                                 */
/* ------------------------------------------------------------------ */

function vendorOf(url) {
  const u = url.toLowerCase();
  if (/linkedin\.com\/jobs\/view/.test(u)) return "linkedin";
  if (/greenhouse\.io|[?&]gh_jid=/.test(u)) return "greenhouse"; // gh_jid = a Greenhouse board embedded in a company site
  if (/[?&]ashby_jid=/.test(u)) return "ashby-embed";
  if (/jobs\.lever\.co/.test(u)) return "lever";
  if (/ashbyhq\.com/.test(u)) return "ashby";
  if (/smartrecruiters\.com/.test(u)) return "smartrecruiters";
  if (/recruitee\.com/.test(u)) return "recruitee";
  if (/breezy\.hr/.test(u)) return "breezy";
  if (/workable\.com/.test(u)) return "workable";
  if (/traffit\.com/.test(u)) return "traffit";
  if (/myworkdayjobs|successfactors|taleo|icims|oraclecloud|jobvite|eightfold|avature|careers\.cognizant|careers\.epam|luxoft\.com|himalayas\.app|indeed\.com/.test(u)) return "portal";
  return "generic";
}

const APPLY_BUTTON = /^\s*(apply|apply now|apply for this (job|position)|apply to position|i'm interested|aplikuj|aplikuj teraz|złóż aplikację|submit your application|start application|easy apply)\s*$/i;
const SUBMIT_BUTTON = /^\s*(submit|submit application|submit your application|send|send application|apply|apply now|wyślij|wyślij aplikację|aplikuj|complete application|finish)\s*$/i;
const SUCCESS = /thank you for (applying|your application|your interest in this|submitting)|thanks for applying|application (has been |was )?(submitted|received|sent|complete)|we('ve| have) received your application|successfully (submitted|applied)|your application (is|was) (in|submitted)|dziękujemy za (aplikacj|zgłoszeni|przesłani)|aplikacja została wysłana|you('ve| have) applied|application sent/i;
const CAPTCHA = /recaptcha|hcaptcha|cf-turnstile|captcha/i;
const EMAIL_CODE = /verification code was sent|enter the \d-character code|security code|confirm you're a human|verify your email/i;

async function openForm(page, vendor, applyUrl) {
  let url = applyUrl;
  if (vendor === "lever" && !/\/apply/.test(url)) url = url.replace(/\/?(\?.*)?$/, "/apply$1");
  if (vendor === "ashby" && !/\/application/.test(url)) url = url.replace(/\/?(\?.*)?$/, "/application$1");
  if (vendor === "recruitee" && !/\/c\/new/.test(url)) url = url.replace(/\/?(\?.*)?$/, "/c/new$1");
  if (vendor === "breezy" && !/\/apply/.test(url)) url = url.replace(/\/?(\?.*)?$/, "/apply$1");
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2500);

  if (vendor === "linkedin") {
    const top = await page.evaluate(() => (document.querySelector(".job-details-jobs-unified-top-card__container--two-pane, .jobs-unified-top-card, .job-details-jobs-unified-top-card__primary-description-container, main")?.innerText ?? "").slice(0, 1500)).catch(() => "");
    const workplace = /\bhybrid\b/i.test(top) ? "hybrid" : /\bon-?site\b/i.test(top) ? "onsite" : /\bremote\b/i.test(top) ? "remote" : "unknown";
    if (workplace === "hybrid" || workplace === "onsite") return { ok: false, reason: `linkedin says ${workplace}`, notRemote: true };
    if (/sign in|join now|log in/i.test(await page.title()) || (await page.locator("input#session_key, input[name=session_key]").count()) > 0) return { ok: false, reason: "not logged in to LinkedIn — run: node scripts/apply.mjs --login" };
    // The top card has either an "Easy Apply" button (modal) or an "Apply" link to the employer's ATS.
    // LinkedIn's new UI obfuscates class names, so go by accessible name and position.
    const topCard = async (locator) => {
      const n = await locator.count().catch(() => 0);
      for (let i = 0; i < n; i += 1) {
        const el = locator.nth(i);
        const box = await el.boundingBox().catch(() => null);
        if (box && box.width > 0 && box.y < 900) return el;
      }
      return null;
    };
    const easy = await topCard(page.getByRole("button", { name: /^\s*easy apply/i }));
    if (!easy) {
      const applyLink =
        (await topCard(page.locator('[data-view-name="job-apply-button"], button[aria-label*="apply on company" i], a[aria-label*="apply on company" i]'))) ??
        (await topCard(page.getByRole("link", { name: /^\s*apply\b/i }))) ??
        (await topCard(page.getByRole("button", { name: /^\s*apply\b/i }))) ??
        (await topCard(page.locator("a, button").filter({ hasText: /^\s*Apply\s*$/ })));
      if (!applyLink) return { ok: false, reason: "no Apply button (closed, or not logged in)" };
      let target = null;
      const href = await applyLink.getAttribute("href").catch(() => null);
      let direct = null;
      if (href) {
        try {
          const u = new URL(href, page.url());
          direct = u.searchParams.get("url") ?? u.searchParams.get("redirect") ?? (u.hostname.endsWith("linkedin.com") ? null : u.toString());
        } catch { direct = null; }
      }
      if (direct) {
        target = await page.context().newPage();
        await target.goto(direct, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      } else {
        let [newPage] = await Promise.all([
          page.context().waitForEvent("page", { timeout: 8000 }).catch(() => null),
          applyLink.click({ timeout: 5000 }).catch(() => {}),
        ]);
        if (!newPage) {
          // "Share your profile?" / "You're leaving LinkedIn" dialog: confirm once, then the site opens in a new tab.
          const dlg = page.locator("dialog[open], dialog, div[role=dialog], [aria-modal=true]").filter({ hasText: /share your profile|leaving linkedin|company website|continue/i }).first();
          if (await dlg.isVisible().catch(() => false)) {
            const go = dlg.locator("button, a, [role=button]").filter({ hasText: /^(continue|proceed|apply|don'?t share|continue without sharing|not now|skip)\b/i }).first();
            [newPage] = await Promise.all([
              page.context().waitForEvent("page", { timeout: 15000 }).catch(() => null),
              go.click({ timeout: 5000 }).catch(() => {}),
            ]);
          }
        }
        target = newPage ?? page;
        await target.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
      }
      await target.waitForTimeout(3000);
      const onLinkedIn = () => { try { return new URL(target.url()).hostname.endsWith("linkedin.com"); } catch { return true; } };
      if (onLinkedIn()) {
        // "You're leaving LinkedIn" interstitial: follow the external link once.
        const go = target.locator("a[href^='http']:not([href*='linkedin.com'])").first();
        if (await go.isVisible().catch(() => false)) { await go.click().catch(() => {}); await target.waitForTimeout(3000); }
      }
      if (onLinkedIn()) return { ok: false, reason: `external apply did not leave LinkedIn (${target.url().slice(0, 80)})` };
      return { ok: false, external: target };
    }
    await easy.click();
    await page.waitForTimeout(3500);
    // The new LinkedIn UI renders the Easy Apply flow in a native <dialog>; the old one in div[role=dialog].
    const dialog = page.locator("dialog[open], dialog, div[role=dialog], .jobs-easy-apply-modal, .artdeco-modal").first();
    if (!(await dialog.isVisible().catch(() => false))) return { ok: false, reason: "Easy Apply modal did not open" };
    return { ok: true, scope: "dialog[open], dialog, div[role=dialog], .jobs-easy-apply-modal, .artdeco-modal" };
  }

  const hasForm = async () => (await page.locator('form input[type=file], form input[type=email], form input[name*="email" i]').count()) > 0;

  // A careers page that embeds a known ATS in an iframe: open the iframe's own URL instead —
  // the standalone form is the same form without the wrapper.
  {
    const ATS_FRAME = /ashbyhq\.com|greenhouse\.io|lever\.co|workable\.com|recruitee\.com|teamtailor\.com|breezy\.hr|smartrecruiters\.com|bamboohr\.com|personio/i;
    if (!ATS_FRAME.test(page.url())) {
      const fromFrames = page.frames().find((f) => f !== page.mainFrame() && ATS_FRAME.test(f.url()))?.url() ?? null;
      const fromSrc = fromFrames ?? (await page.locator("iframe[src]").evaluateAll((els, re) => els.map((e) => e.getAttribute("src")).find((src) => new RegExp(re, "i").test(src ?? "")) ?? null, ATS_FRAME.source).catch(() => null));
      if (fromSrc) {
        log(`embedded ATS → ${fromSrc.slice(0, 120)}`);
        await page.goto(new URL(fromSrc, page.url()).toString(), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(3000);
      }
    }
  }

  // If no form is visible yet, follow the apply link (its href when it has one — a zero-size
  // mobile button still carries the form URL) or press the apply button once.
  if (!(await hasForm())) {
    const candidates = await page.evaluate((pattern) => {
      const re = new RegExp(pattern, "i");
      return [...document.querySelectorAll("a, button, input[type=submit]")]
        .map((e, i) => ({ i, text: (e.innerText || e.value || e.getAttribute("aria-label") || "").trim(), href: e.getAttribute("href"), tag: e.tagName, visible: e.getBoundingClientRect().width > 0 }))
        .filter((e) => re.test(e.text));
    }, APPLY_BUTTON.source).catch(() => []);
    const withHref = candidates.find((c) => c.href && !/^(#|javascript:)/.test(c.href) && !/mailto:/.test(c.href));
    if (withHref) {
      await page.goto(new URL(withHref.href, page.url()).toString(), { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(2500);
    } else if (candidates.length) {
      const visibleOne = candidates.find((c) => c.visible) ?? candidates[0];
      const el = page.locator("a, button, input[type=submit]").filter({ hasText: visibleOne.text || undefined }).first();
      if (visibleOne.tag === "INPUT") await page.locator(`input[type=submit][value="${visibleOne.text.replace(/"/g, '\\"')}"]`).first().click({ force: true, timeout: 5000 }).catch(() => {});
      else await el.click({ force: true, timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }
  }
  if (vendor === "smartrecruiters" || /oneclick-ui/.test(page.url())) await page.waitForTimeout(2500);
  if (!(await hasForm())) {
    // Teamtailor opens the form in a side panel; Greenhouse legacy boards use an iframe.
    const frame = page.frames().find((f) => /greenhouse\.io\/embed/.test(f.url()));
    if (frame) return { ok: true, frame };
    if ((await page.locator("input, textarea, select").count()) < 3) return { ok: false, reason: "no application form found on the page" };
  }
  return { ok: true, scope: (await page.locator("form").count()) > 0 ? null : null };
}

async function clickButton(scope, regex) {
  const buttons = scope.locator("button, input[type=submit], a[role=button]");
  const count = await buttons.count();
  for (let i = count - 1; i >= 0; i -= 1) {
    const b = buttons.nth(i);
    const text = ((await b.innerText().catch(() => "")) || (await b.getAttribute("value").catch(() => "")) || (await b.getAttribute("aria-label").catch(() => "")) || "").trim();
    if (regex.test(text) && (await b.isVisible().catch(() => false))) {
      await b.scrollIntoViewIfNeeded().catch(() => {});
      await b.click({ timeout: 5000 }).catch(() => {});
      return text;
    }
  }
  return null;
}

async function collectErrors(page) {
  return page.evaluate(() => {
    const sel = '[aria-invalid="true"], .error, [class*="error" i]:not(form):not(body), [role="alert"], .field_error, .invalid-feedback';
    return [...document.querySelectorAll(sel)]
      .filter((e) => e.getBoundingClientRect().height > 0)
      .map((e) => (e.innerText || e.getAttribute("aria-label") || e.name || "").replace(/\s+/g, " ").trim())
      .filter((t) => t && t.length < 200)
      .slice(0, 8);
  });
}

async function recordInFunnel(args, applyUrl) {
  const body = {
    url: args.url ?? applyUrl,
    title: args.title,
    company: args.company,
    source: args.source ?? "manual",
    location: args.location ?? null,
    salary: args.salary ?? null,
  };
  const response = await fetch(DASHBOARD + "/api/applications", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await response.json().catch(() => ({}));
  return json.application ? `#${json.application.id} ${json.result}` : `funnel error ${response.status}`;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  mkdirSync(USER_DATA, { recursive: true });
  mkdirSync(SHOTS, { recursive: true });

  if (flags.login) {
    const context = await chromium.launchPersistentContext(USER_DATA, { channel: "chrome", headless: false, viewport: null });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://www.linkedin.com/login");
    log("Log in to LinkedIn in this window, then close the window.");
    await new Promise((resolveDone) => context.on("close", resolveDone));
    return 0;
  }

  const applyUrl = positional[0];
  if (!applyUrl || !flags.title || !flags.company) {
    log("usage: apply.mjs <applyUrl> --url <postingUrl> --company .. --title .. [--source ..] [--cover ..] [--answers ..] [--dry-run] [--headed]");
    return 1;
  }
  let vendor = vendorOf(applyUrl);
  if (vendor === "portal") {
    console.log(JSON.stringify({ result: "needs-account", vendor, applyUrl }));
    return 4;
  }
  const extra = flags.answers ? JSON.parse(readFileSync(flags.answers, "utf8")) : {};
  if (flags.cover === "auto") extra.__cover = autoCover(flags.company, flags.title, String(flags.stack ?? ""));
  else if (flags.cover) extra.__cover = existsSync(flags.cover) ? readFileSync(flags.cover, "utf8") : flags.cover;

  const headed = Boolean(flags.headed) || vendor === "linkedin" || vendor === "greenhouse";
  const profileDir = vendor === "linkedin" ? USER_DATA : USER_DATA_ATS;
  mkdirSync(profileDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, { channel: "chrome", headless: !headed, viewport: { width: 1280, height: 1400 }, userAgent: headed ? undefined : UA });
  // A stuck click must fail in seconds, not hang the job for the batch's whole timeout.
  context.setDefaultTimeout(10_000);
  let page = context.pages()[0] ?? (await context.newPage());
  const slug = `${flags.company}-${flags.title}`.replace(/[^a-z0-9]+/gi, "-").slice(0, 60).toLowerCase();
  const shot = async (suffix) => { const file = join(SHOTS, `${slug}-${suffix}.png`); await page.screenshot({ path: file, fullPage: true }).catch(() => {}); return file; };
  const report = [];

  try {
    let opened = await openForm(page, vendor, applyUrl);
    if (opened.external) {
      page = opened.external;
      vendor = vendorOf(page.url());
      log(`linkedin → external ${vendor} ${page.url().slice(0, 120)}`);
      if (vendor === "portal") { console.log(JSON.stringify({ result: "needs-account", vendor, applyUrl: page.url() })); return 4; }
      opened = await openForm(page, vendor, page.url());
    }
    if (!opened.ok && !opened.notRemote) {
      const ATS_FRAME = /ashbyhq\.com|greenhouse\.io|lever\.co|workable\.com|recruitee\.com|teamtailor\.com|breezy\.hr|smartrecruiters\.com|bamboohr\.com|personio/i;
      const embedded = page.frames().find((f) => f !== page.mainFrame() && ATS_FRAME.test(f.url()));
      const embedUrl = embedded?.url() ?? (await page.locator("iframe[src]").evaluateAll((els, re) => els.map((e) => e.getAttribute("src")).find((src) => new RegExp(re, "i").test(src ?? "")) ?? null, ATS_FRAME.source).catch(() => null));
      if (embedUrl) {
        log(`embedded ATS → ${embedUrl.slice(0, 120)}`);
        vendor = vendorOf(embedUrl);
        await page.goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(2500);
        opened = await openForm(page, vendor, page.url());
      }
    }
    if (!opened.ok) {
      const file = await shot("noform");
      console.log(JSON.stringify({ result: opened.notRemote ? "not-remote" : "no-form", reason: opened.reason, url: page.url(), screenshot: file }));
      return opened.notRemote ? 5 : 4;
    }
    const html = await page.content();
    if (/sign in to apply|log in to apply|create (an )?account to apply|create your account/i.test(html)) {
      console.log(JSON.stringify({ result: "needs-account", url: page.url() }));
      return 4;
    }
    if (CAPTCHA.test(html) && (await page.locator('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], .cf-turnstile').count()) > 0) {
      const visibleCaptcha = await page.locator('iframe[src*="recaptcha/api2/anchor"], iframe[src*="hcaptcha"], .cf-turnstile').first().isVisible().catch(() => false);
      if (visibleCaptcha) { console.log(JSON.stringify({ result: "captcha", url: page.url() })); return 4; }
    }

    const target = opened.frame ?? page;
    keys = page;
    const scope = opened.scope ?? null;
    let missing = [];
    let steps = 0;
    let submittedText = null;

    // Multi-step forms (LinkedIn Easy Apply, some Workable/SmartRecruiters flows): fill, Next, repeat.
    while (steps < 12) {
      steps += 1;
      missing = await fillControls(target, scope, extra, report);
      // Second pass: fields revealed by the first one (CV parse, conditional questions).
      if (missing.length) missing = await fillControls(target, scope, extra, report);
      if (missing.length) break;
      if (flags["dry-run"]) break;
      const scoped = scope ? target.locator(scope) : target;
      const nextText = vendor === "linkedin" ? await clickButton(scoped, /^(next|continue|continue to next step|review|review your application)$/i) : null;
      if (nextText) { await page.waitForTimeout(1800); continue; }
      submittedText = await clickButton(scoped, SUBMIT_BUTTON);
      if (!submittedText) {
        const typed = scoped.locator("form button[type=submit]:visible, form input[type=submit]:visible, button[type=submit]:visible").last();
        if (await typed.count().catch(() => 0)) {
          submittedText = ((await typed.innerText().catch(() => "")) || (await typed.getAttribute("value").catch(() => "")) || "submit").trim();
          await typed.scrollIntoViewIfNeeded().catch(() => {});
          await typed.click({ timeout: 5000 }).catch(() => { submittedText = null; });
        }
      }
      break;
    }

    if (missing.length) {
      const file = await shot("missing");
      console.log(JSON.stringify({ result: "missing-answers", missing, filled: report, screenshot: file }, null, 1));
      return 2;
    }
    if (flags["dry-run"]) {
      const file = await shot("dryrun");
      console.log(JSON.stringify({ result: "dry-run", filled: report, screenshot: file }, null, 1));
      return 0;
    }
    if (!submittedText) {
      const file = await shot("nosubmit");
      console.log(JSON.stringify({ result: "no-submit-button", filled: report, screenshot: file }));
      return 3;
    }

    // Wait for a confirmation, or for validation errors. An e-mailed verification code is a
    // human check: the script never fetches it — the person types it into the open window.
    let success = false;
    let codeStep = false;
    let deadline = Date.now() + 18_000;
    while (Date.now() < deadline && !success) {
      await page.waitForTimeout(1500);
      const doc = opened.frame ?? page;
      const text = await doc.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      const formStillHere = (await doc.locator("form input[type=email], form input[type=file], form textarea").count().catch(() => 0)) > 0;
      if (!codeStep && EMAIL_CODE.test(text)) {
        codeStep = true;
        if (!headed) {
          const file = await shot("code");
          console.log(JSON.stringify({ result: "needs-code", reason: "the board e-mailed a verification code; re-run with --headed and type it", filled: report, screenshot: file }));
          return 6;
        }
        log(`>>> ${flags.company}: a verification code was e-mailed to ${PROFILE.email}. Type it into the open Chrome window and press Submit (waiting up to 5 minutes).`);
        deadline = Date.now() + 300_000;
        continue;
      }
      if (codeStep && EMAIL_CODE.test(text) && formStillHere) continue; // still waiting for the person
      if (SUCCESS.test(text) || /confirmation/i.test(page.url())) success = true;
      if (vendor === "linkedin" && /application sent|your application was sent/i.test(text)) success = true;
      // Greenhouse replaces the form with the confirmation; a form that is still there was not sent.
      if (success && formStillHere && vendor !== "linkedin") success = false;
    }
    if (!success) {
      const errors = await collectErrors(page);
      const stillHasForm = (await (opened.frame ?? page).locator("form input[type=email], form input[type=file]").count()) > 0;
      if (!stillHasForm && errors.length === 0) success = true; // form gone, no errors: accepted
      else {
        const file = await shot("failed");
        console.log(JSON.stringify({ result: "submit-failed", button: submittedText, errors, filled: report, screenshot: file }, null, 1));
        return 3;
      }
    }
    const funnel = await recordInFunnel(flags, applyUrl);
    if (vendor === "linkedin") await clickButton(page, /^(done|dismiss|close)$/i);
    console.log(JSON.stringify({ result: "applied", funnel, button: submittedText, filled: report }));
    return 0;
  } finally {
    await context.close().catch(() => {});
  }
}

process.exit(await main());
