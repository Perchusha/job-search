/**
 * index.ts — the MCP server. Six tools over stdio.
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
  getStats,
  insertApplication,
  listApplications,
  resolveDbPath,
  updateStatus,
  type Application,
  type Status,
} from "./db.ts";
import { presentJob, searchJobs } from "./pipeline.ts";
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
const sourceEnum = z.enum(["himalayas", "remoteok", "arbeitnow"]);

/* ------------------------------------------------------------------ */
/* 1. find_jobs — a thin wrapper over searchJobs()                     */
/* ------------------------------------------------------------------ */

server.tool(
  "find_jobs",
  "Search free remote-job feeds (Himalayas, RemoteOK, Arbeitnow) and score each result for whether a Poland-based (EU) candidate can actually apply. Returns an eligibility level and reason plus the apply URL for each job.",
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
      .describe("Subset of sources to query. Defaults to all three"),
    onlyEligible: z
      .boolean()
      .optional()
      .describe("Drop jobs scored 'low' (cannot apply from Poland). Default true"),
    limit: z.number().int().positive().max(100).optional().describe("Max jobs to return, default 20"),
  },
  async ({ query, seniority, worldwideOnly, minSalary, sources, onlyEligible, limit }) => {
    let result;
    try {
      result = await searchJobs({
        query,
        seniority,
        worldwideOnly,
        minSalary,
        sources,
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
        (query ? ` for "${query}"` : "") +
        ".",
      `Sources: ${formatSourceReports(result.reports)}`,
      `Pipeline: ${counts.fetched} fetched -> ${counts.deduped} after dedupe -> ${counts.afterEligibility} after eligibility${
        minSalary === undefined ? "" : ` -> ${counts.afterSalary} after minSalary`
      } -> ${counts.returned} returned.`,
      `Eligibility mix: ${
        Object.entries(result.levelCounts)
          .map(([level, count]) => `${level}=${count}`)
          .join(", ") || "none"
      }.`,
    ];
    if (onlyEligible ?? true) {
      lines.push("Jobs restricted away from Poland (level 'low') were excluded.");
    }
    if (counts.hiddenForUnknownSalary > 0) {
      lines.push(
        `${counts.hiddenForUnknownSalary} job(s) hidden because they publish no salary and minSalary was set.`,
      );
    }
    lines.push("To track any of these, pass them to log_found_jobs (adds them as 'saved').");

    return reply(lines.join("\n"), { jobs: result.jobs.map(presentJob) });
  },
);

/* ------------------------------------------------------------------ */
/* 1b. log_found_jobs — bulk search -> funnel in one call              */
/* ------------------------------------------------------------------ */

server.tool(
  "log_found_jobs",
  "Bulk-add jobs from find_jobs output straight into the funnel. Defaults to status 'saved' (found, not yet applied) so response rates stay honest. Idempotent per URL: an already-tracked URL is reported, never duplicated.",
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
      .describe("Status to insert with. Default 'saved' — use 'applied' only if you really applied"),
  },
  async ({ jobs, status }) => {
    const initialStatus = (status ?? "saved") as Status;

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

    const summary = [
      `${inserted} job(s) added to the funnel as "${initialStatus}", ${existing} already tracked${
        failed > 0 ? `, ${failed} failed` : ""
      }.`,
      initialStatus === "saved"
        ? "These count as found-not-applied: use update_status to move them to 'applied' when you actually apply (that also resets applied_at to the real application date)."
        : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n");

    return reply(summary, { results });
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
        `${stats.total} tracked, ${stats.totalApplied} actually applied (excludes 'saved').`,
        `Funnel: ${funnelLine || "empty"}.`,
        `Response rate: ${percent(stats.responseRate)} (${stats.responded}/${stats.totalApplied}).`,
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
  console.error("[job-hunt] MCP server ready on stdio (6 tools).");
}

main().catch((error) => {
  console.error("[job-hunt] fatal:", error);
  process.exit(1);
});
