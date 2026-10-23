/**
 * tests/fake-claude.mjs — stands in for `claude -p` in tests/ui.mjs
 * (JOBHUNT_CLAUDE points here), so the verdict flow runs offline and costs
 * nothing. It answers the way `--output-format json --json-schema` does: one
 * JSON object with `structured_output`. A posting that names Angular is a
 * "skip", anything else an "apply" — and one that says LIMIT-TEST gets the
 * plan's usage limit, word for word as Claude Code 2.1.287 reports it.
 *
 * FAKE_CLAUDE_LOG, when set, gets one JSON line per call — the arguments and
 * the prompt — so the test can check what the dashboard actually sent.
 */

import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", () => {
  if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ args, prompt }) + "\n");
  if (prompt.includes("LIMIT-TEST")) {
    process.stdout.write(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 429,
        result: "You've hit your session limit · resets 11pm (Europe/Warsaw)",
        session_id: args[args.indexOf("--session-id") + 1],
      }),
    );
    return;
  }
  const skip = /angular/i.test(prompt);
  const output = {
    workMode: "remote",
    workModeQuote: "Fully remote",
    canWorkFromPoland: "yes",
    seniority: "senior",
    mainStack: [skip ? "Angular" : "React"],
    salary: "",
    matches: skip ? [] : ["React и TypeScript"],
    concerns: ["зарплата не указана"],
    dealbreakers: skip ? ["основной стек — Angular: «Angular 17»"] : [],
    verdict: skip ? "skip" : "apply",
    score: skip ? 10 : 90,
    summary: skip ? "Angular, а не React." : "Подходит: React, удалённо.",
    hideReason: skip ? "не тот стек" : "",
  };
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: JSON.stringify(output),
      structured_output: output,
      session_id: args[args.indexOf("--session-id") + 1],
      total_cost_usd: 0,
      modelUsage: { "claude-test-1-0": {} },
    }),
  );
});
