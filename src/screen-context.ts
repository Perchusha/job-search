/**
 * screen-context.ts — the screening context as the database has it: the
 * funnel, the hidden list, and what Settings added on top (cards freed from
 * the rules, companies given back, hides forgotten). The dashboard and the
 * MCP server screen with this; screening.ts itself stays free of the database,
 * so funnel.mjs can import it.
 */

import { listApplications, listDismissed, listForget, listRuleOverrides } from "./db.ts";
import { buildContext, type ScreenContext } from "./screening.ts";

export function storedContext(options: { rulesOff?: string[] } = {}): ScreenContext {
  const forget = listForget();
  return buildContext(listApplications(), listDismissed(), {
    overrides: listRuleOverrides().map((row) => row.job_key),
    rulesOff: options.rulesOff,
    forgetCompanies: forget.filter((row) => row.kind === "company").map((row) => row.key),
    forgetHides: forget.filter((row) => row.kind === "hide").map((row) => row.key),
  });
}
