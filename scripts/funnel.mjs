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
/* Screening — shared with the dashboard's search                      */
/* ------------------------------------------------------------------ */

// One copy of the rules: src/screening.ts (mechanics) and src/profile.ts (the
// lists). Plain Node imports TypeScript here (type stripping, Node 22.18+).
import { buildContext, decide } from "../src/screening.ts";

function ageDays(postedAt) {
  if (!postedAt) return null;
  const ms = Date.now() - new Date(postedAt).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null;
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

async function loadContext() {
  const [{ applications }, { dismissed }] = await Promise.all([
    api("GET", "/api/applications"),
    api("GET", "/api/dismissed"),
  ]);
  return { ...buildContext(applications, dismissed), rows: applications };
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
  const applied = new Set(context.appliedKeys);
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(
    `${result.jobs.length} jobs · cache ${result.cache.hit ? "hit" : "miss"} (${result.cache.ageSeconds}s) · ` +
      Object.entries(result.sourceCounts).map(([k, v]) => `${k} ${v}`).join(" · "),
  );
  result.jobs.forEach((job, index) => {
    const flag = job.dismissed ? "DISMISSED" : applied.has(job.key) ? "APPLIED" : "";
    console.log(line(index, job, flag));
  });
}

async function cmdScreen(flags) {
  const [result, context] = await Promise.all([loadSearch(flags), loadContext()]);
  const decisions = [];
  result.jobs.forEach((job, index) => {
    const decision = decide({ ...job, url: job.applyUrl }, context, decisions);
    decisions.push({ index, job, ...decision });
  });

  const buckets = ["apply", "check", "needs-you", "dismiss", "skip"];
  for (const bucket of buckets) {
    const rows = decisions.filter((row) => row.bucket === bucket);
    if (rows.length === 0) continue;
    console.log(`\n== ${bucket.toUpperCase()} (${rows.length}) ==`);
    for (const row of rows) {
      const flags = row.flags.length > 0 ? ` !${row.flags.join("; ")}` : "";
      console.log(line(row.index, row.job, `<${row.reason}>${flags}`));
    }
  }

  if (flags.json) {
    const { writeFileSync } = await import("node:fs");
    const out = decisions.map(({ index, job, bucket, reason, flags }) => ({
      index,
      bucket,
      reason,
      flags,
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
