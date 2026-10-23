#!/usr/bin/env node
/**
 * funnel.mjs — command line over the running dashboard (http://localhost:4321)
 * for the `job-screen`, `job-apply` and `job-pipeline` skills.
 *
 * No dependencies: Node 20+ `fetch` only. The dashboard must be running
 * (`Job Hunt.bat` or `npm run dashboard`); every command talks to its API, so
 * the SQLite file is never opened twice.
 *
 *   node scripts/funnel.mjs search [--refresh] [--json]
 *       The profile search as the Search tab sees it, one line per job, with
 *       APPLIED / DISMISSED flags resolved against the funnel.
 *   node scripts/funnel.mjs screen [--commit] [--json <file>]
 *       Sort the search into apply / check / dismiss / needs-you buckets with
 *       a reason each. Dry-run by default; --commit writes the dismissals.
 *   node scripts/funnel.mjs dismiss <url> --reason "..." [--title ..] [--company ..]
 *   node scripts/funnel.mjs undismiss <url>
 *   node scripts/funnel.mjs add --url <url> --title ".." --company ".." [--source ..] [--location ..] [--salary ..]
 *       Record an application. Idempotent on url (already_tracked).
 *   node scripts/funnel.mjs applied | dismissed | stats
 *   node scripts/funnel.mjs status <id> <status>
 *
 * Exit code 0 on success, 1 on a usage or API error.
 */

const BASE = (process.env["JOBHUNT_URL"] ?? "http://localhost:4321").replace(/\/$/, "");

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

async function api(method, path, body) {
  let response;
  try {
    response = await fetch(BASE + path, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    fail(`cannot reach the dashboard at ${BASE} — is "Job Hunt.bat" / npm run dashboard running? (${error.message})`);
  }
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    fail(`${method} ${path} → ${response.status}: ${text.slice(0, 200)}`);
  }
  if (!response.ok) fail(`${method} ${path} → ${response.status}: ${json.error ?? text.slice(0, 200)}`);
  return json;
}

function fail(message) {
  console.error("error: " + message);
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Args                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/* ------------------------------------------------------------------ */
/* Normalisation — how "the same role" is recognised                   */
/* ------------------------------------------------------------------ */

const CANON = [
  [/full[\s-]*stack/g, "fullstack"],
  [/front[\s-]*end/g, "frontend"],
  [/back[\s-]*end/g, "backend"],
  [/react[\s.]*js\b/g, "react"],
  [/node[\s.]*js\b/g, "node"],
  [/next[\s.]*js\b/g, "next"],
  [/nest[\s.]*js\b/g, "nest"],
  [/vue[\s.]*js\b/g, "vue"],
  [/type[\s-]*script/g, "typescript"],
  [/java[\s-]*script/g, "javascript"],
];

function norm(value) {
  let text = (value ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  for (const [pattern, replacement] of CANON) text = text.replace(pattern, replacement);
  return text.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

// Words that say nothing about *which* role it is.
const TITLE_STOP = new Set(
  "senior sr lead staff principal expert mid middle regular junior developer engineer software programista the and with of a an m f d x k nb w remote in at to for team specialist".split(" "),
);

function titleTokens(title) {
  return new Set(norm(title).split(" ").filter((token) => token.length > 1 && !TITLE_STOP.has(token)));
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

const COMPANY_SUFFIX =
  /\b(sp z o ?o|sp z oo|s a|sa|ltd|limited|inc|llc|gmbh|ag|plc|group|poland|polska|technologies|technology|solutions|software house|co)\b/g;

function companyKey(company) {
  return norm(company).replace(COMPANY_SUFFIX, " ").replace(/\s+/g, " ").trim();
}

function sameCompany(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short + " ");
}

/* ------------------------------------------------------------------ */
/* Screening rules                                                     */
/* ------------------------------------------------------------------ */

const T = (pattern) => new RegExp(`(?<![a-z0-9])(?:${pattern})(?![a-z0-9])`, "i");

/** Title-level rejections. Order matters: the first match is the reason. */
const TITLE_RULES = [
  ["junior/intern level", T("junior|intern|internship|trainee|graduate|entry[- ]level|mlodszy|młodszy|staz|staż|praktyk\\w*|apprentice")],
  ["mid-level role, CV is senior", T("middle|mid[- ]?level|regular|engineer (?:2|ii)|developer (?:2|ii)")],
  ["management role, not engineering", T("head of|engineering manager|director|cto|vp|vice president|chief")],
  // AI-training gigs (rating model output, writing prompts for a lab) are not
  // engineering work, whatever the title says about TypeScript.
  ["AI-training gig, not engineering", T("ai training|ai trainer|ai tutor|data annotation|rlhf")],
  ["not an engineering role", T("recruiter|talent|designer|ui/ux design|product manager|project manager|scrum master|business analyst|analyst|account manager|customer success|support|advocate|consultant|informatyk|administrator|technical writer|documentation")],
  ["QA / test role", T("qa|test engineer|tester|sdet|quality|automation test|automation engineer")],
  ["DevOps / infra / security role", T("devops|sre|site reliability|security|cloud architect|platform lead|network|infrastructure|k8s|kubernetes")],
  ["data / ML role", T("data engineer|data scientist|ml engineer|machine learning|deep learning|mlops|data visuali[sz]ation|computer vision")],
  ["AI/ML role, not frontend", T("ai engineer|ai architect|genai|llm engineer|ai infrastructure|ai platform|solutions? architect|agentic solution|ai lead|lead ai|ai engineering")],
  ["mobile role", T("mobile|react native|android|ios|flutter|swift|kotlin|hybrid app")],
  ["wrong stack: .NET / Java", T("\\.net|c#|asp\\.net|java|jvm|spring|kotlin|scala")],
  ["wrong stack: other language", T("python|django|fastapi|ruby|rails|golang|go developer|go engineer|\\(go\\)|rust|elixir|erlang|c\\+\\+|embedded|unity|unreal")],
  ["wrong stack: other frontend framework", T("angular|angularjs|vue|svelte|ui5|sapui5|blazor")],
  ["wrong stack: platform / CMS / ERP", T("shopify|wordpress|drupal|magento|salesforce|sap|abap|sharepoint|power platform|dynamics 365|copilot studio|netsuite|1c|servicenow|low[- ]code|appian|mendix|outsystems|pega|webflow|website editor")],
  ["PHP-first role", T("php|laravel|symfony")],
  ["requires another language", T("german|deutsch|italian|french|spanish|dutch|polish speaker|with (?:german|italian|french|spanish|dutch)|(?:german|italian|french|spanish|dutch)[- ]speaking")],
];

// Tested against the *normalised* title, so "Full-Stack" and "Node.js" match.
const FRONTEND = T("react|frontend|fullstack|next|web|ui engineer|product engineer");
const BACKEND_ONLY = T("node|nest|backend|microservices|api developer");

/**
 * Boards and marketplaces that hire through their own account/vetting flow.
 * The skills cannot create accounts, so these go to the "needs you" list.
 */
const ACCOUNT_MARKETPLACES = T("lemon\\.io|jobgether|gitstart|proxify|micro1|alignerr|toptal|turing|crossover|upwork|braintrust|andela|arc\\.dev|remotepass");

const STALE_DAYS = 60;

function ageDays(postedAt) {
  if (!postedAt) return null;
  const ms = Date.now() - new Date(postedAt).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null;
}

/**
 * Decide one job. Returns { bucket, reason } with bucket one of
 * "apply" | "check" | "dismiss" | "skip" | "needs-you".
 */
function decide(job, context, earlier) {
  const { applications, dismissed, dismissedByCompany, appliedByCompany } = context;
  const title = job.title;
  const plain = norm(title);
  const company = companyKey(job.company);
  const tokens = titleTokens(title);

  if (job.dismissed) return { bucket: "skip", reason: "already hidden" };

  // Already in the funnel — by url, or the same role at the same company.
  for (const application of applications) {
    if (application.url === job.applyUrl) {
      return { bucket: "skip", reason: `already in funnel (#${application.id}, ${application.status})` };
    }
    if (sameCompany(company, application.companyKey) && jaccard(tokens, application.tokens) >= 0.5) {
      return {
        bucket: "dismiss",
        reason: `duplicate of application #${application.id} (${application.status}): ${application.title}`,
      };
    }
  }

  // The same role was hidden before under another url.
  for (const hidden of dismissed) {
    if (sameCompany(company, hidden.companyKey) && jaccard(tokens, hidden.tokens) >= 0.5) {
      return { bucket: "dismiss", reason: `same role hidden earlier: ${hidden.title}` };
    }
  }

  // A company hidden twice or more, never applied to: not interested.
  const hiddenCount = dismissedByCompany.get(company) ?? 0;
  const appliedCount = appliedByCompany.get(company) ?? 0;
  if (hiddenCount >= 2 && appliedCount === 0) {
    return { bucket: "dismiss", reason: `company hidden ${hiddenCount}× before` };
  }

  for (const [reason, pattern] of TITLE_RULES) {
    if (pattern.test(title)) {
      // "Russian speaker" is fine — native language.
      if (reason.startsWith("requires") && /russian/i.test(title)) continue;
      // "AI" in a frontend/fullstack title is a bonus, not the role.
      if (reason.startsWith("AI/ML") && FRONTEND.test(title)) continue;
      // "QA" false positives: "Quality" never appears in a dev title, but keep the guard.
      if (reason.startsWith("QA") && FRONTEND.test(title) && !/\bqa\b|tester|sdet/i.test(title)) continue;
      return { bucket: "dismiss", reason };
    }
  }

  if (BACKEND_ONLY.test(plain) && !FRONTEND.test(plain)) {
    return { bucket: "dismiss", reason: "backend-only role" };
  }

  const age = ageDays(job.postedAt);
  if (age !== null && age > STALE_DAYS) {
    return { bucket: "dismiss", reason: `posting is ${age} days old` };
  }

  // A second posting of the same role inside this very search.
  for (const previous of earlier) {
    if (previous.bucket === "dismiss" || previous.bucket === "skip") continue;
    if (sameCompany(company, companyKey(previous.job.company)) && jaccard(tokens, titleTokens(previous.job.title)) >= 0.5) {
      return {
        bucket: "dismiss",
        reason: `duplicate posting of #${previous.index} ${previous.job.title} (${previous.job.source})`,
      };
    }
  }

  if (ACCOUNT_MARKETPLACES.test(job.company) || ACCOUNT_MARKETPLACES.test(job.applyUrl)) {
    return { bucket: "needs-you", reason: "marketplace / aggregator — needs an account, apply by hand" };
  }

  const geo = job.eligibility?.reason ?? "";
  // Indeed sets is_remote reliably, so its onsite/hybrid verdict is final.
  if (job.source === "indeed" && /^onsite\/hybrid/i.test(geo)) {
    return { bucket: "dismiss", reason: "not remote (onsite/hybrid per Indeed)" };
  }
  if (job.eligibility?.level === "high") {
    return { bucket: "apply", reason: geo };
  }
  return { bucket: "check", reason: geo };
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

async function loadContext() {
  const [{ applications }, { dismissed }] = await Promise.all([
    api("GET", "/api/applications"),
    api("GET", "/api/dismissed"),
  ]);
  const withKeys = (rows) =>
    rows.map((row) => ({
      ...row,
      companyKey: companyKey(row.company),
      tokens: titleTokens(row.title),
    }));
  const count = (rows) => {
    const map = new Map();
    for (const row of rows) map.set(row.companyKey, (map.get(row.companyKey) ?? 0) + 1);
    return map;
  };
  const apps = withKeys(applications);
  const hidden = withKeys(dismissed);
  return {
    applications: apps,
    dismissed: hidden,
    appliedByCompany: count(apps),
    dismissedByCompany: count(hidden),
  };
}

async function loadSearch(flags) {
  const params = [];
  if (flags.refresh) params.push("refresh=1");
  if (flags.sources) params.push("sources=" + encodeURIComponent(flags.sources));
  if (flags.hoursOld) params.push("hoursOld=" + encodeURIComponent(flags.hoursOld));
  return api("GET", "/api/search" + (params.length ? "?" + params.join("&") : ""));
}

function line(index, job, extra = "") {
  const geo = job.eligibility?.level === "high" ? "geo✓" : "geo?";
  const age = ageDays(job.postedAt);
  return [
    String(index).padStart(3),
    job.source.padEnd(9),
    `${job.match.level}/${String(job.fit).padStart(3)}`,
    geo,
    (age === null ? "?" : age + "d").padStart(4),
    `${job.company} — ${job.title}`,
    job.location ? `[${job.location}]` : "",
    job.salary ? `{${job.salary}}` : "",
    extra,
    job.applyUrl,
  ]
    .filter(Boolean)
    .join("  ");
}

async function cmdSearch(flags) {
  const [result, context] = await Promise.all([loadSearch(flags), loadContext()]);
  const applied = new Set(context.applications.map((row) => row.url));
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `${result.jobs.length} jobs · cache ${result.cache.hit ? "hit" : "miss"} (${result.cache.ageSeconds}s) · ` +
      Object.entries(result.sourceCounts).map(([k, v]) => `${k} ${v}`).join(" · "),
  );
  result.jobs.forEach((job, index) => {
    const flag = job.dismissed ? "DISMISSED" : applied.has(job.applyUrl) ? "APPLIED" : "";
    console.log(line(index, job, flag));
  });
}

async function cmdScreen(flags) {
  const [result, context] = await Promise.all([loadSearch(flags), loadContext()]);
  const decisions = [];
  result.jobs.forEach((job, index) => {
    const decision = decide(job, context, decisions);
    decisions.push({ index, job, ...decision });
  });

  const buckets = ["apply", "check", "needs-you", "dismiss", "skip"];
  for (const bucket of buckets) {
    const rows = decisions.filter((row) => row.bucket === bucket);
    if (rows.length === 0) continue;
    console.log(`\n== ${bucket.toUpperCase()} (${rows.length}) ==`);
    for (const row of rows) console.log(line(row.index, row.job, `<${row.reason}>`));
  }

  if (flags.json) {
    const { writeFileSync } = await import("node:fs");
    const out = decisions.map(({ index, job, bucket, reason }) => ({
      index,
      bucket,
      reason,
      title: job.title,
      company: job.company,
      source: job.source,
      url: job.applyUrl,
      location: job.location,
      salary: job.salary,
      postedAt: job.postedAt,
      fit: job.fit,
      match: job.match.level,
      eligibility: job.eligibility,
    }));
    writeFileSync(flags.json, JSON.stringify(out, null, 2));
    console.log(`\nwrote ${out.length} decisions to ${flags.json}`);
  }

  const toDismiss = decisions.filter((row) => row.bucket === "dismiss");
  if (!flags.commit) {
    console.log(`\ndry run: ${toDismiss.length} would be hidden. Re-run with --commit to hide them.`);
    return;
  }
  let hidden = 0;
  for (const row of toDismiss) {
    const response = await api("POST", "/api/dismissed", {
      url: row.job.applyUrl,
      title: row.job.title,
      company: row.job.company,
      reason: row.reason,
    });
    if (response.result !== "already_hidden") hidden += 1;
  }
  console.log(`\nhidden ${hidden} of ${toDismiss.length}`);
}

async function cmdDismiss(positional, flags) {
  const url = positional[0];
  if (!url) fail("usage: dismiss <url> --reason \"...\" [--title ..] [--company ..]");
  const body = { url, reason: flags.reason ?? null, title: flags.title ?? null, company: flags.company ?? null };
  const response = await api("POST", "/api/dismissed", body);
  console.log(JSON.stringify(response));
}

async function cmdUndismiss(positional) {
  const url = positional[0];
  if (!url) fail("usage: undismiss <url>");
  console.log(JSON.stringify(await api("DELETE", "/api/dismissed", { url })));
}

async function cmdAdd(flags) {
  for (const key of ["url", "title", "company"]) {
    if (typeof flags[key] !== "string") fail(`add needs --${key}`);
  }
  const body = {
    url: flags.url,
    title: flags.title,
    company: flags.company,
    source: flags.source ?? "manual",
    location: flags.location ?? null,
    salary: flags.salary ?? null,
  };
  const response = await api("POST", "/api/applications", body);
  console.log(
    `${response.result} #${response.application.id} ${response.application.company} — ${response.application.title} (${response.application.status})`,
  );
}

async function cmdApplied() {
  const { applications } = await api("GET", "/api/applications");
  for (const row of applications) {
    console.log(`#${String(row.id).padStart(3)}  ${row.status.padEnd(9)}  ${row.applied_at.slice(0, 10)}  ${row.company} — ${row.title}  ${row.url ?? ""}`);
  }
}

async function cmdDismissed() {
  const { dismissed } = await api("GET", "/api/dismissed");
  for (const row of dismissed) {
    console.log(`${row.dismissed_at.slice(0, 10)}  ${row.company ?? "?"} — ${row.title ?? "?"}  <${row.reason ?? ""}>  ${row.url}`);
  }
}

async function cmdStats() {
  console.log(JSON.stringify(await api("GET", "/api/stats"), null, 2));
}

async function cmdStatus(positional) {
  const [id, status] = positional;
  if (!id || !status) fail("usage: status <id> <status>");
  console.log(JSON.stringify(await api("POST", `/api/applications/${id}/status`, { status })));
}

/* ------------------------------------------------------------------ */

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, ...rest] = positional;

switch (command) {
  case "search":
    await cmdSearch(flags);
    break;
  case "screen":
    await cmdScreen(flags);
    break;
  case "dismiss":
    await cmdDismiss(rest, flags);
    break;
  case "undismiss":
    await cmdUndismiss(rest);
    break;
  case "add":
    await cmdAdd(flags);
    break;
  case "applied":
    await cmdApplied();
    break;
  case "dismissed":
    await cmdDismissed();
    break;
  case "stats":
    await cmdStats();
    break;
  case "status":
    await cmdStatus(rest);
    break;
  default:
    console.log(
      [
        "usage: node scripts/funnel.mjs <command>",
        "  search [--refresh] [--json]",
        "  screen [--commit] [--json <file>]",
        "  dismiss <url> --reason \"...\" [--title ..] [--company ..]",
        "  undismiss <url>",
        "  add --url .. --title .. --company .. [--source ..] [--location ..] [--salary ..]",
        "  applied | dismissed | stats",
        "  status <id> <status>",
      ].join("\n"),
    );
    process.exit(command ? 1 : 0);
}
