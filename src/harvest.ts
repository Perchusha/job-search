/**
 * harvest.ts — the unattended run. `npm run harvest`
 *
 * Searches the profile, saves the good matches into the funnel as `saved`, and
 * prints a digest. Idempotent: dedupe is by URL, so running it twice in a row
 * adds nothing the second time. Safe to schedule daily.
 *
 * Deliberately not an MCP tool and not the dashboard: this must work with no
 * assistant and no browser open, which is the whole point of scheduling it.
 *
 * Flags:
 *   --dry-run       find and report, write nothing
 *   --no-linkedin   skip LinkedIn even if the profile enables it
 *   --limit=N       cap how many are added this run
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  DEFAULT_STALE_DAYS,
  insertApplication,
  listApplications,
  resolveDbPath,
  type Application,
} from "./db.ts";
import { HARVEST, SEARCH_DEFAULTS, stackFit } from "./profile.ts";
import { searchForProfile, type RankedJob } from "./pipeline.ts";
import { formatSourceReports, type SourceName } from "./sources.ts";

/* ------------------------------------------------------------------ */
/* Output                                                             */
/* ------------------------------------------------------------------ */

const lines: string[] = [];

/** Print and remember, so the whole digest can also go to the log file. */
function say(line = ""): void {
  console.log(line);
  lines.push(line);
}

/**
 * Scheduled tasks discard stdout, so the digest is also appended to a log next
 * to the database. Without this a nightly run is invisible.
 */
function writeLog(): void {
  const path = join(dirname(resolveDbPath()), "harvest.log");
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `\n${"=".repeat(70)}\n${lines.join("\n")}\n`, "utf8");
    console.log(`\nlog: ${path}`);
  } catch (error) {
    console.error(`could not write log: ${(error as Error).message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Args                                                               */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const noLinkedin = argv.includes("--no-linkedin");
const limitArg = argv.find((arg) => arg.startsWith("--limit="));
const maxToAdd = limitArg ? Number(limitArg.split("=")[1]) : HARVEST.maxPerRun;

/* ------------------------------------------------------------------ */
/* Run                                                                */
/* ------------------------------------------------------------------ */

function describeJob(job: RankedJob): string {
  const where = job.location ?? "—";
  return `${job.company} — ${job.title}`.slice(0, 68).padEnd(68) + ` ${where.slice(0, 22)}`;
}

async function main(): Promise<void> {
  const startedAt = new Date();
  say(`job-hunt harvest — ${startedAt.toISOString()}`);
  say(`database: ${resolveDbPath()}`);
  if (dryRun) say("DRY RUN — nothing will be written");

  // LinkedIn is worth its ~25s here; it is only excluded interactively.
  const sources: SourceName[] = [...SEARCH_DEFAULTS.sources];
  if (HARVEST.includeLinkedin && !noLinkedin && !sources.includes("linkedin")) {
    sources.push("linkedin");
  }

  let result;
  try {
    result = await searchForProfile({
      sources,
      maxFitTier: HARVEST.maxFitTier,
      // Fetch well past maxPerRun: the best matches are chosen after ranking,
      // and most of what comes back is already in the funnel from earlier runs.
      limit: 200,
    });
  } catch (error) {
    say(`FAILED: ${error instanceof Error ? error.message : String(error)}`);
    writeLog();
    process.exit(1);
  }

  say();
  say(`sources:  ${formatSourceReports(result.reports)}`);
  say(
    `pipeline: ${result.counts.fetched} fetched -> ${result.counts.deduped} deduped -> ` +
      `${result.counts.afterEligibility} eligible -> ${result.counts.afterFit} good fit ` +
      `(${result.counts.hiddenForFit} dropped)`,
  );

  /* ---- save the good matches ---- */

  const added: RankedJob[] = [];
  const alreadyTracked: RankedJob[] = [];

  for (const job of result.jobs) {
    if (added.length >= maxToAdd) break;

    if (dryRun) {
      added.push(job);
      continue;
    }

    try {
      const { alreadyExisted } = insertApplication({
        company: job.company,
        title: job.title,
        url: job.url,
        source: job.source,
        location: job.location,
        salary: job.salary,
        status: "saved",
      });
      if (alreadyExisted) alreadyTracked.push(job);
      else added.push(job);
    } catch (error) {
      say(`  ! could not save ${job.url}: ${(error as Error).message}`);
    }
  }

  say();
  // "added to the funnel", not "newly posted": the cap counts insertions, so
  // each run works down the ranked backlog until only fresh postings are left.
  say(`ADDED TO FUNNEL (${added.length})${dryRun ? " — would add" : ""}:`);
  if (added.length === 0) say("  nothing to add — every match found is already in the funnel");
  for (const job of added) say(`  fit ${String(stackFit(job)).padStart(3)}  ${describeJob(job)}`);
  if (alreadyTracked.length > 0) say(`\nalready in the funnel: ${alreadyTracked.length}`);

  // Subtract what was already tracked too, or the number grows every run.
  const remaining = result.jobs.length - added.length - alreadyTracked.length;
  if (remaining > 0) {
    // Never silently truncate — say what was left behind, and why.
    say(
      `\nnote: ${remaining} further match(es) left for the next run ` +
        `(cap is ${maxToAdd} per run; raise HARVEST.maxPerRun or pass --limit=N)`,
    );
  }

  /* ---- nudges: what needs a human ---- */

  const applications = listApplications({ staleDays: DEFAULT_STALE_DAYS });
  const ghosted = applications.filter((row) => row.status === "ghosted");
  const needsFollowUp = applications.filter(
    (row) =>
      row.status === "applied" &&
      row.response_at === null &&
      row.daysSinceApplied >= HARVEST.followUpAfterDays,
  );
  const active = applications.filter((row) =>
    ["responded", "screening", "interview", "offer"].includes(row.status),
  );

  const list = (rows: Application[]) =>
    rows
      .slice(0, 10)
      .map((row) => `  #${row.id} ${row.company} — ${row.title}`.slice(0, 78) + ` (${row.daysSinceApplied}d)`);

  if (needsFollowUp.length > 0) {
    say(`\nFOLLOW UP (${needsFollowUp.length}) — applied, no reply for ${HARVEST.followUpAfterDays}+ days:`);
    for (const line of list(needsFollowUp)) say(line);
  }
  if (active.length > 0) {
    say(`\nIN PROGRESS (${active.length}):`);
    for (const row of active.slice(0, 10)) {
      say(`  #${row.id} [${row.status}] ${row.company} — ${row.title}`.slice(0, 78));
    }
  }
  if (ghosted.length > 0) say(`\nghosted: ${ghosted.length} (no reply in ${DEFAULT_STALE_DAYS}+ days)`);

  const saved = applications.filter((row) => row.status === "saved").length;
  say(
    `\nfunnel: ${saved} saved, ${applications.length - saved} applied+, ` +
      `${applications.length} tracked total`,
  );
  say(`took ${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)}s`);

  if (!dryRun) writeLog();
}

main().catch((error) => {
  console.error("harvest failed:", error);
  process.exit(1);
});
