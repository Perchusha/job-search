/**
 * index.ts — the MCP server. Eight tools over stdio.
 *
 * IMPORTANT: stdout is the MCP transport. Never console.log here — diagnostics
 * go to stderr, or the client will fail to parse the protocol stream.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  DEFAULT_STALE_DAYS,
  STATUSES,
  addNote,
  dismissJob,
  listDismissed,
  undismissJob,
  getStats,
  insertApplication,
  listApplications,
  resolveDbPath,
  updateStatus,
  type Application,
  type Status,
} from "./db.ts";
import { presentJob, searchForProfile, searchJobs } from "./pipeline.ts";
import { SEARCH_DEFAULTS, TARGET_QUERIES } from "./profile.ts";
import { formatSourceReports } from "./sources.ts";

const server = new McpServer({ name: "job-hunt", version: "1.0.0" });

/* ------------------------------------------------------------------ */
/* Response helpers                                                    */
/* ------------------------------------------------------------------ */

/** Every tool answers with a human summary followed by compact JSON. */
function reply(summary: string, data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${summary}\n\n${JSON.stringify(data)}`,
      },
    ],
  };
}

function replyError(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

/** Trims a tracked application down to what an assistant needs to see. */
function summarizeApplication(application: Application) {
  return {
    id: application.id,
    company: application.company,
    title: application.title,
    status: application.status,
    ghosted: application.ghosted,
    appliedAt: application.applied_at,
    daysSinceApplied: application.daysSinceApplied,
    responseAt: application.response_at,
    daysToResponse: application.daysToResponse,
    url: application.url,
    source: application.source,
    location: application.location,
    salary: application.salary,
    notes: application.notes,
  };
}

const statusEnum = z.enum(STATUSES);
const sourceEnum = z.enum([
  // scraped via JobSpy — volume + descriptions, no salary data
  "indeed",
  "linkedin",
  "glassdoor",
  "google",
  "zip_recruiter",
  // free public feeds — thinner, but Himalayas has salaries + real geo metadata
  "himalayas",
  "remoteok",
  "arbeitnow",
]);

/* ------------------------------------------------------------------ */
/* 1. find_jobs — a thin wrapper over searchJobs()                     */
/* ------------------------------------------------------------------ */

server.tool(
  "find_jobs",
  "Find jobs worth applying to. Called with NO arguments it searches the saved profile in src/profile.ts (my target searches, Poland, remote-only, wrong-stack and junior roles dropped) — that is the normal way to use it. The profile search skips LinkedIn: it takes ~80s on its own and would blow the request timeout. The dashboard queries it; this tool does not unless you name it in `sources`. Pass arguments only for a one-off, different search. Returns an eligibility level and reason plus the apply URL. Scraped boards give volume and descriptions but no salary; Himalayas is the only source with published salaries.",
  {
    query: z.string().optional().describe("Free-text search, e.g. 'senior react typescript'"),
    seniority: z
      .enum(["Entry-level", "Mid-level", "Senior", "Manager", "Director", "Executive"])
      .optional()
      .describe("Himalayas-only filter; other sources ignore it"),
    worldwideOnly: z
      .boolean()
      .optional()
      .describe("Himalayas-only: restrict to jobs with no location restriction at all"),
    minSalary: z
      .number()
      .optional()
      .describe("Annual minimum. Only jobs that publish a salary can match this"),
    sources: z
      .array(sourceEnum)
      .optional()
      .describe("Which boards to query. Default: indeed + himalayas. Add 'linkedin' for more coverage — it is ~25s slower and its metadata is poor"),
    location: z
      .string()
      .optional()
      .describe("Scraped boards: where to search, default 'Poland'. Indeed is country-scoped, so a country or city works ('Berlin, Germany') but supranational values ('European Union') only work for linkedin"),
    remoteOnly: z
      .boolean()
      .optional()
      .describe("Scraped boards only: restrict to remote postings"),
    hoursOld: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Scraped boards only: only postings newer than this many hours (default 336 = 14d)"),
    onlyEligible: z
      .boolean()
      .optional()
      .describe("Drop jobs scored 'low' (cannot apply from Poland). Default true"),
    limit: z.number().int().positive().max(100).optional().describe("Max jobs to return, default 20"),
  },
  async ({
    query,
    seniority,
    worldwideOnly,
    minSalary,
    sources,
    location,
    remoteOnly,
    hoursOld,
    onlyEligible,
    limit,
  }) => {
    /**
     * With no query at all, search the saved profile (src/profile.ts): my
     * target searches, Poland, remote-only, wrong-stack roles dropped. The
     * stack does not change between runs, so "find me jobs" needs no arguments.
     */
    const useProfile =
      !query && !seniority && !location && minSalary === undefined && !sources?.length;

    let result;
    try {
      result = useProfile
        ? await searchForProfile({
            limit,
            onlyEligible,
            remoteOnly,
            hoursOld,
            // Minus the boards that cannot answer inside the MCP request
            // timeout — see SEARCH_DEFAULTS.slowSources for the measurement.
            sources: SEARCH_DEFAULTS.sources.filter(
              (source) => !SEARCH_DEFAULTS.slowSources.includes(source),
            ),
          })
        : await searchJobs({
            query,
            seniority,
            worldwideOnly,
            minSalary,
            sources,
            location,
            remoteOnly,
            hoursOld,
            onlyEligible,
            limit,
          });
    } catch (error) {
      return replyError(
        `every source failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const { counts } = result;
    const lines = [
      `Found ${counts.returned} job(s) you can apply to from Poland` +
        (counts.queries.length > 0 ? ` for ${counts.queries.map((q) => `"${q}"`).join(", ")}` : "") +
        (useProfile ? " (saved profile)" : "") +
        ".",
      `Sources: ${formatSourceReports(result.reports)}`,
      `Pipeline: ${counts.fetched} fetched -> ${counts.deduped} after dedupe -> ${counts.afterEligibility} after eligibility${
        counts.afterFit === counts.afterEligibility ? "" : ` -> ${counts.afterFit} after stack fit`
      }${minSalary === undefined ? "" : ` -> ${counts.afterSalary} after minSalary`} -> ${counts.returned} returned.`,
      `Eligibility mix: ${
        Object.entries(result.levelCounts)
          .map(([level, count]) => `${level}=${count}`)
          .join(", ") || "none"
      }.`,
    ];
    if (onlyEligible ?? true) {
      lines.push("Jobs restricted away from Poland (level 'low') were excluded.");
    }
    if (counts.hiddenForDismissed > 0) {
      lines.push(`${counts.hiddenForDismissed} job(s) hidden by dismiss_job.`);
    }
    if (counts.hiddenForFit > 0) {
      lines.push(
        `${counts.hiddenForFit} job(s) dropped as a poor stack fit (wrong stack, junior, or non-engineering).`,
      );
    }
    if (counts.hiddenForUnknownSalary > 0) {
      lines.push(
        `${counts.hiddenForUnknownSalary} job(s) hidden because they publish no salary and minSalary was set.`,
      );
    }
    lines.push("To track any of these, pass them to log_found_jobs — everything in the funnel counts as applied, so only pass the ones I actually applied to.");

    return reply(lines.join("\n"), { jobs: result.jobs.map(presentJob) });
  },
);

/* ------------------------------------------------------------------ */
/* 1b. log_found_jobs — bulk search -> funnel in one call              */
/* ------------------------------------------------------------------ */

server.tool(
  "log_found_jobs",
  "Bulk-add jobs from find_jobs output straight into the funnel as applications. There is no bookmark stage: a row in the funnel means I applied, so only pass jobs I really applied to. Idempotent per URL: an already-tracked URL is reported, never duplicated.",
  {
    jobs: z
      .array(
        z.object({
          url: z.string().min(1).describe("Apply URL — the dedupe key"),
          title: z.string().min(1),
          company: z.string().min(1),
          source: z.string().optional(),
          location: z.string().optional(),
          salary: z.string().optional(),
        }),
      )
      .min(1)
      .max(100)
      .describe("Jobs to track. Pass find_jobs results through directly"),
    status: statusEnum
      .optional()
      .describe("Status to insert with. Default 'applied' — pass a later stage only if it is already further along"),
  },
  async ({ jobs, status }) => {
    const initialStatus = (status ?? "applied") as Status;

    const results = jobs.map((job) => {
      try {
        const { application, alreadyExisted } = insertApplication({
          company: job.company,
          title: job.title,
          url: job.url,
          source: job.source ?? "manual",
          location: job.location ?? null,
          salary: job.salary ?? null,
          status: initialStatus,
        });
        return {
          url: job.url,
          result: alreadyExisted ? ("already_tracked" as const) : ("inserted" as const),
          id: application.id,
          status: application.status,
        };
      } catch (error) {
        return {
          url: job.url,
          result: "error" as const,
          id: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });

    const inserted = results.filter((row) => row.result === "inserted").length;
    const existing = results.filter((row) => row.result === "already_tracked").length;
    const failed = results.filter((row) => row.result === "error").length;

    const summary = `${inserted} job(s) added to the funnel as "${initialStatus}", ${existing} already tracked${
      failed > 0 ? `, ${failed} failed` : ""
    }.`;

    return reply(summary, { results });
  },
);

/* ------------------------------------------------------------------ */
/* 1c. dismiss_job — "stop showing me this"                            */
/* ------------------------------------------------------------------ */

server.tool(
  "dismiss_job",
  "Hide a job from every future search — both the dashboard and find_jobs honour it. Use for roles I am not interested in. Pass restore:true to un-hide, or list:true to see what is hidden.",
  {
    url: z.string().optional().describe("Apply URL of the job to hide (or restore)"),
    title: z.string().optional(),
    company: z.string().optional(),
    reason: z.string().optional().describe("Why, for your own reference later"),
    restore: z.boolean().optional().describe("Un-hide this URL instead of hiding it"),
    list: z.boolean().optional().describe("Return everything currently hidden"),
  },
  async ({ url, title, company, reason, restore, list }) => {
    try {
      if (list) {
        const hidden = listDismissed();
        return reply(`${hidden.length} job(s) hidden from search.`, { dismissed: hidden });
      }
      if (!url) return replyError("url is required (or pass list:true)");

      if (restore) {
        const restored = undismissJob(url);
        return reply(
          restored ? "Restored — it can show up in searches again." : "That URL was not hidden.",
          { restored, url },
        );
      }

      const { dismissed, alreadyHidden } = dismissJob({ url, title, company, reason });
      return reply(
        alreadyHidden
          ? "Already hidden — nothing changed."
          : `Hidden. It will not appear in search or find_jobs again.`,
        { dismissed, result: alreadyHidden ? "already_hidden" : "hidden" },
      );
    } catch (error) {
      return replyError(error instanceof Error ? error.message : String(error));
    }
  },
);

/* ------------------------------------------------------------------ */
/* 2. log_application                                                 */
/* ------------------------------------------------------------------ */

server.tool(
  "log_application",
  "Record that I applied to a job. Idempotent on URL: if that URL was already logged, the existing row is returned instead of creating a duplicate.",
  {
    company: z.string().min(1),
    title: z.string().min(1),
    url: z.string().min(1).describe("Apply URL — also the dedupe key"),
    source: z.string().optional().describe("himalayas/remoteok/arbeitnow/manual"),
    location: z.string().optional(),
    salary: z.string().optional(),
    notes: z.string().optional().describe("Stored as the first timestamped note"),
  },
  async ({ company, title, url, source, location, salary, notes }) => {
    try {
      const { application, alreadyExisted } = insertApplication({
        company,
        title,
        url,
        source: source ?? "manual",
        location: location ?? null,
        salary: salary ?? null,
        notes: notes ?? null,
      });

      const summary = alreadyExisted
        ? `Already logged as #${application.id} (${application.company} — ${application.title}, status "${application.status}", applied ${application.applied_at}). Nothing was duplicated.`
        : `Logged application #${application.id}: ${application.company} — ${application.title} (status "applied").`;

      return reply(summary, { application: summarizeApplication(application), alreadyExisted });
    } catch (error) {
      return replyError(error instanceof Error ? error.message : String(error));
    }
  },
);

/* ------------------------------------------------------------------ */
/* 3. update_status                                                    */
/* ------------------------------------------------------------------ */

server.tool(
  "update_status",
  "Move a tracked application to a new stage. Any status past 'applied' (responded/screening/interview/offer/rejected) stamps response_at automatically when it isn't already set.",
  {
    id: z.number().int().positive(),
    status: statusEnum,
    responseAt: z.string().optional().describe("ISO timestamp; defaults to now when implied"),
  },
  async ({ id, status, responseAt }) => {
    try {
      const application = updateStatus(id, status as Status, responseAt);
      if (!application) return replyError(`no application with id ${id}`);

      const responseNote = application.response_at
        ? ` response_at=${application.response_at}`
        : "";
      return reply(
        `Application #${application.id} (${application.company} — ${application.title}) is now "${status}".${responseNote}`,
        { application: summarizeApplication(application) },
      );
    } catch (error) {
      return replyError(error instanceof Error ? error.message : String(error));
    }
  },
);

/* ------------------------------------------------------------------ */
/* 4. add_note                                                         */
/* ------------------------------------------------------------------ */

server.tool(
  "add_note",
  "Append a timestamped note to a tracked application (recruiter names, interview feedback, salary talk).",
  {
    id: z.number().int().positive(),
    note: z.string().min(1),
  },
  async ({ id, note }) => {
    try {
      const application = addNote(id, note);
      if (!application) return replyError(`no application with id ${id}`);
      return reply(`Note added to #${application.id} (${application.company}).`, {
        application: summarizeApplication(application),
      });
    } catch (error) {
      return replyError(error instanceof Error ? error.message : String(error));
    }
  },
);

/* ------------------------------------------------------------------ */
/* 5. list_applications                                                */
/* ------------------------------------------------------------------ */

server.tool(
  "list_applications",
  "List tracked applications, newest first. 'ghosted' is derived at read time: status 'applied', no reply, older than staleDays.",
  {
    status: statusEnum.optional().describe("Filter by effective status, including 'ghosted'"),
    staleDays: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Days without a reply before an application counts as ghosted (default ${DEFAULT_STALE_DAYS})`),
  },
  async ({ status, staleDays }) => {
    try {
      const applications = listApplications({
        status: status as Status | undefined,
        staleDays: staleDays ?? DEFAULT_STALE_DAYS,
      });

      const summary =
        applications.length === 0
          ? `No applications${status ? ` with status "${status}"` : ""} yet.`
          : `${applications.length} application(s)${status ? ` with status "${status}"` : ""}. ` +
            `Ghost threshold: ${staleDays ?? DEFAULT_STALE_DAYS} days.`;

      return reply(summary, { applications: applications.map(summarizeApplication) });
    } catch (error) {
      return replyError(error instanceof Error ? error.message : String(error));
    }
  },
);

/* ------------------------------------------------------------------ */
/* 6. get_stats                                                        */
/* ------------------------------------------------------------------ */

server.tool(
  "get_stats",
  "Funnel counts plus response rate, ghost rate and average days to first response across all tracked applications.",
  {},
  async () => {
    try {
      const stats = getStats();
      const percent = (value: number) => `${Math.round(value * 100)}%`;

      const funnelLine = Object.entries(stats.funnel)
        .filter(([, count]) => count > 0)
        .map(([status, count]) => `${status}=${count}`)
        .join(", ");

      const summary = [
        `${stats.total} application(s) tracked.`,
        `Funnel: ${funnelLine || "empty"}.`,
        `Response rate: ${percent(stats.responseRate)} (${stats.responded}/${stats.total}).`,
        `Ghost rate: ${percent(stats.ghostRate)} at a ${stats.staleDays}-day threshold.`,
        `Average days to first response: ${stats.avgDaysToResponse ?? "n/a"}.`,
      ].join("\n");

      return reply(summary, stats);
    } catch (error) {
      return replyError(error instanceof Error ? error.message : String(error));
    }
  },
);

/* ------------------------------------------------------------------ */
/* Boot                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  // stderr is safe; stdout belongs to the protocol.
  console.error(`[job-hunt] database: ${resolveDbPath()}`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[job-hunt] MCP server ready on stdio (8 tools).");
}

main().catch((error) => {
  console.error("[job-hunt] fatal:", error);
  process.exit(1);
});
