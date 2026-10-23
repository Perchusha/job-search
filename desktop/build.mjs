/**
 * build.mjs — `npm run build`: the Windows installer, dist/Job Hunt Setup <v>.exe.
 *
 * The installed app is a shell around this repo: it starts the dashboard
 * server from here (node_modules, .venv, the database path all stay as they
 * are). So the repo's absolute path is baked into the packaged package.json
 * as jobHunt.repoDir. Move the repo and rebuild, or set JOBHUNT_REPO.
 */

import { build, Platform } from "electron-builder";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(here, "..");

const result = await build({
  projectDir: here,
  targets: Platform.WINDOWS.createTarget("nsis"),
  config: {
    extraMetadata: { jobHunt: { repoDir } },
  },
});
console.log(`built for ${repoDir}:\n${result.join("\n")}`);
