/**
 * tests/mcp.mjs — end-to-end test of the MCP server over real stdio.
 *
 * Run: npm run test:mcp
 *
 * Drives the server exactly as a client would: spawns `tsx src/index.ts`,
 * speaks the protocol, and asserts on tool output. Uses a throwaway database,
 * never the real one. `find_jobs` hits the live job boards, so this needs
 * network and takes a few seconds.
 */

import Database from "better-sqlite3";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const DB = join(tmpdir(), `job-hunt-test-mcp-${process.pid}.db`);
function removeDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(DB + suffix, { force: true });
    } catch {
      // Windows can hold the file briefly after the child exits; harmless.
    }
  }
}
removeDb();

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const textOf = (result) => result.content.map((part) => part.text).join("\n");
/** Tool replies are "<summary>\n\n<json>" — take the JSON half. */
const jsonOf = (result) => {
  const text = textOf(result);
  return JSON.parse(text.slice(text.indexOf("{", text.indexOf("\n\n"))));
};

async function connect() {
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/index.ts"],
    env: { ...process.env, JOBHUNT_DB: DB },
  });
  const client = new Client({ name: "job-hunt-tests", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

async function main() {
  let { client, transport } = await connect();

  /* ---------------- tools ---------------- */
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  check("all 8 tools registered", names.length === 8, names.join(", "));
  for (const expected of [
    "find_jobs",
    "log_found_jobs",
    "log_application",
    "update_status",
    "add_note",
    "list_applications",
    "get_stats",
    "dismiss_job",
  ]) {
    check(`  ${expected}`, names.includes(expected));
  }

  /* ---------------- find_jobs (live network) ---------------- */
  const found = await client.callTool({ name: "find_jobs", arguments: {} });
  const foundText = textOf(found);
  const jobs = jsonOf(found).jobs;

  check("find_jobs with no args returns jobs", jobs.length > 0, `${jobs.length} jobs`);
  check("uses the saved profile", foundText.includes("saved profile"));
  check("every job has eligibility level + reason",
    jobs.every((job) => job.eligibility?.level && job.eligibility?.reason));
  check("every job has a separate professional match level + reason",
    jobs.every((job) => job.match?.level && job.match?.reason));
  check("every job has an http apply URL",
    jobs.every((job) => typeof job.applyUrl === "string" && job.applyUrl.startsWith("http")));
  check("no 'low' eligibility leaks through",
    jobs.every((job) => job.eligibility.level !== "low"));
  check("no wrong-stack jobs (fit >= 0)",
    jobs.every((job) => job.fit >= 0), `min fit ${Math.min(...jobs.map((job) => job.fit))}`);
  check("no junior/intern titles",
    !jobs.some((job) => /intern|junior|praktyk|staż/i.test(job.title)));
  check("ranked best-fit first",
    jobs[0].fit >= jobs[jobs.length - 1].fit, `${jobs[0].fit} -> ${jobs[jobs.length - 1].fit}`);
  check("descriptions kept out of tool output",
    !JSON.stringify(jobs).includes("description"));

  const oneOff = await client.callTool({
    name: "find_jobs",
    arguments: { query: "electron", limit: 5 },
  });
  check("an explicit query is a one-off, not the profile",
    !textOf(oneOff).includes("saved profile"));

  /* ---------------- log_found_jobs ---------------- */
  const payload = jobs.slice(0, 4).map((job) => ({
    url: job.applyUrl,
    title: job.title,
    company: job.company,
    source: job.source,
  }));

  const firstAdd = jsonOf(await client.callTool({
    name: "log_found_jobs",
    arguments: { jobs: payload },
  })).results;
  check("bulk add inserts all 4", firstAdd.filter((row) => row.result === "inserted").length === 4);
  check("inserted as 'applied' — the funnel has no bookmark stage",
    firstAdd.every((row) => row.status === "applied"));

  const secondAdd = jsonOf(await client.callTool({
    name: "log_found_jobs",
    arguments: { jobs: payload },
  })).results;
  check("re-adding reports already_tracked",
    secondAdd.every((row) => row.result === "already_tracked"));
  check("re-adding returns the same ids",
    JSON.stringify(secondAdd.map((r) => r.id)) === JSON.stringify(firstAdd.map((r) => r.id)));
  check("no duplicate rows created",
    jsonOf(await client.callTool({ name: "list_applications", arguments: {} })).applications.length === 4);

  /* ---------------- manual logging + status flow ---------------- */
  const manual = jsonOf(await client.callTool({
    name: "log_application",
    arguments: { company: "Manual Co", title: "Dev", url: "https://example.com/m1", notes: "referred" },
  })).application;
  check("log_application defaults to 'applied'", manual.status === "applied");
  check("initial note is timestamped", /^\[\d{4}-\d{2}-\d{2}T/.test(manual.notes));

  const dup = jsonOf(await client.callTool({
    name: "log_application",
    arguments: { company: "Manual Co", title: "Dev", url: "https://example.com/m1" },
  }));
  check("duplicate URL returns the existing row",
    dup.alreadyExisted === true && dup.application.id === manual.id);

  const trackedId = firstAdd[0].id;
  const applied = jsonOf(await client.callTool({
    name: "update_status",
    arguments: { id: trackedId, status: "applied" },
  })).application;
  check("a bulk-added row is applied as of today", applied.daysSinceApplied === 0);
  check("'applied' does not imply a reply", !applied.responseAt);

  const interview = jsonOf(await client.callTool({
    name: "update_status",
    arguments: { id: trackedId, status: "interview" },
  })).application;
  check("moving past 'applied' stamps response_at", Boolean(interview.responseAt));

  // Walking away is not a reply. Dropping a job nobody answered must not stamp
  // response_at, or giving up would quietly inflate the response rate.
  const droppedSilent = jsonOf(await client.callTool({
    name: "update_status",
    arguments: { id: firstAdd[1].id, status: "dropped" },
  })).application;
  check("'dropped' does not stamp a reply", !droppedSilent.responseAt);
  check("a dropped row is never derived as ghosted",
    droppedSilent.status === "dropped" && !droppedSilent.ghosted);

  // A reply that already happened still counts, though.
  const droppedAfterReply = jsonOf(await client.callTool({
    name: "update_status",
    arguments: { id: trackedId, status: "dropped" },
  })).application;
  check("dropping after they replied keeps the reply",
    droppedAfterReply.responseAt === interview.responseAt);

  const explicit = jsonOf(await client.callTool({
    name: "update_status",
    arguments: { id: manual.id, status: "rejected", responseAt: "2026-08-20T10:00:00.000Z" },
  })).application;
  check("an explicit responseAt is respected",
    explicit.responseAt === "2026-08-20T10:00:00.000Z");

  check("unknown id errors cleanly",
    textOf(await client.callTool({ name: "update_status", arguments: { id: 9999, status: "offer" } }))
      .includes("no application with id 9999"));

  const noted = jsonOf(await client.callTool({
    name: "add_note",
    arguments: { id: trackedId, note: "скрининг назначен" },
  })).application;
  check("add_note appends a timestamped line", noted.notes.split("\n").length >= 1);
  check("non-ASCII notes survive", noted.notes.includes("скрининг"));

  /* ---------------- dismiss_job ---------------- */
  const target = jobs[0].applyUrl;
  const hidden = jsonOf(await client.callTool({
    name: "dismiss_job",
    arguments: { url: target, title: jobs[0].title, company: jobs[0].company, reason: "test" },
  }));
  check("dismiss_job hides a job", hidden.result === "hidden");
  check("dismissing twice is a no-op",
    jsonOf(await client.callTool({ name: "dismiss_job", arguments: { url: target } })).result
      === "already_hidden");
  check("list:true reports what is hidden",
    jsonOf(await client.callTool({ name: "dismiss_job", arguments: { list: true } }))
      .dismissed.some((row) => row.url === target));

  const afterDismiss = await client.callTool({ name: "find_jobs", arguments: {} });
  check("a dismissed job is gone from find_jobs",
    !jsonOf(afterDismiss).jobs.some((job) => job.applyUrl === target));

  /*
   * The "hidden by dismiss_job" line only appears when the search actually ran
   * into a dismissed job, and the boards are live — one hidden URL need not
   * come back on the next call. Hiding the current top five makes an overlap
   * effectively certain without pretending the data is stable.
   */
  const batch = jsonOf(afterDismiss).jobs.slice(0, 5).map((job) => job.applyUrl);
  for (const jobUrl of batch) {
    await client.callTool({ name: "dismiss_job", arguments: { url: jobUrl } });
  }
  const afterBatch = await client.callTool({ name: "find_jobs", arguments: {} });
  check("find_jobs says how many it hid",
    textOf(afterBatch).includes("hidden by dismiss_job"),
    `hiddenForDismissed ${jsonOf(afterBatch).jobs.length} returned`);
  check("no dismissed job is returned",
    !jsonOf(afterBatch).jobs.some((job) => batch.includes(job.applyUrl)));

  check("restore un-hides it",
    jsonOf(await client.callTool({ name: "dismiss_job", arguments: { url: target, restore: true } }))
      .restored === true);
  for (const jobUrl of batch) {
    await client.callTool({ name: "dismiss_job", arguments: { url: jobUrl, restore: true } });
  }
  check("nothing is hidden after restoring",
    jsonOf(await client.callTool({ name: "dismiss_job", arguments: { list: true } }))
      .dismissed.length === 0);
  check("dismiss_job needs a url",
    (await client.callTool({ name: "dismiss_job", arguments: {} })).isError === true);

  /* ---------------- validation ---------------- */
  for (const [label, args, tool] of [
    ["invalid source enum", { sources: ["linkedin_typo"] }, "find_jobs"],
    ["invalid status enum", { id: 1, status: "banana" }, "update_status"],
    ["wrong type for id", { id: "abc", status: "offer" }, "update_status"],
    ["missing required field", { title: "X", url: "https://e.com/x" }, "log_application"],
    ["limit above max", { limit: 9999 }, "find_jobs"],
    ["empty note", { id: 1, note: "" }, "add_note"],
  ]) {
    const result = await client.callTool({ name: tool, arguments: args });
    check(`rejects ${label}`, result.isError === true);
  }

  /* ---------------- stats ---------------- */
  const stats = jsonOf(await client.callTool({ name: "get_stats", arguments: {} }));
  check("'saved' is gone from the vocabulary", stats.funnel.saved === undefined);
  check("the funnel accounts for every tracked row",
    Object.values(stats.funnel).reduce((sum, n) => sum + n, 0) === stats.total,
    `funnel ${JSON.stringify(stats.funnel)} vs total ${stats.total}`);
  check("avgDaysToResponse is never negative",
    stats.avgDaysToResponse === null || stats.avgDaysToResponse >= 0, String(stats.avgDaysToResponse));

  await client.close();
  await transport.close();

  /* ---------------- restart: persistence + derived ghosting ---------------- */
  const raw = new Database(DB);
  raw.prepare("UPDATE applications SET applied_at = ?, status = 'applied', response_at = NULL WHERE url = ?")
    .run(new Date(Date.now() - 40 * 86_400_000).toISOString(), "https://example.com/m1");
  raw.close();

  ({ client, transport } = await connect());

  const rows = jsonOf(await client.callTool({ name: "list_applications", arguments: {} })).applications;
  check("data survives a restart", rows.length === 5, `${rows.length} rows`);
  const stale = rows.find((row) => row.url === "https://example.com/m1");
  check("a 40-day silent application derives as 'ghosted'", stale.status === "ghosted" && stale.ghosted);

  const lenient = jsonOf(await client.callTool({
    name: "list_applications",
    arguments: { staleDays: 90 },
  })).applications.find((row) => row.url === "https://example.com/m1");
  check("staleDays=90 un-ghosts it", lenient.status === "applied");

  check("can filter by the derived 'ghosted' status",
    jsonOf(await client.callTool({ name: "list_applications", arguments: { status: "ghosted" } }))
      .applications.length === 1);

  await client.close();
  await transport.close();

  for (const suffix of ["", "-wal", "-shm"]) rmSync(DB + suffix, { force: true });

  console.log(`\n${failures === 0 ? "MCP TESTS PASSED" : `${failures} MCP TEST(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("test harness crashed:", error);
  process.exit(1);
});
