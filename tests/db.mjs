/**
 * Offline checks for opening the database when better-sqlite3's native binary
 * does not load: the errors are the ones Node and `bindings` really throw, and
 * the rebuild is a stand-in. No network, no database.
 *
 *   node --import tsx tests/db.mjs
 */

import { openRebuilding } from "../src/db.ts";

let failed = 0;
function check(name, ok, detail = "") {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const otherAbi = Object.assign(
  new Error("The module 'better_sqlite3.node'\nwas compiled against a different Node.js version using\n"
    + "NODE_MODULE_VERSION 127. This version of Node.js requires\nNODE_MODULE_VERSION 147."),
  { code: "ERR_DLOPEN_FAILED" },
);
const missing = new Error("Could not locate the bindings file. Tried:\n → build/better_sqlite3.node");
const badFile = Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" });

const MINUTE = 60_000;
let now = 0;

/** One open, `after` ms past the last: `open` throws `errors` in turn, then returns "db". */
function attempt(errors, rebuild = () => {}, after = 60 * MINUTE) {
  now += after;
  const queue = [...errors];
  let rebuilds = 0;
  let result;
  let thrown = null;
  try {
    result = openRebuilding(
      () => {
        const error = queue.shift();
        if (error) throw error;
        return "db";
      },
      () => {
        rebuilds++;
        rebuild();
      },
      now,
    );
  } catch (error) {
    thrown = error;
  }
  return { result, thrown, rebuilds };
}

const healthy = attempt([]);
check("a binary that loads: no rebuild", healthy.result === "db" && healthy.rebuilds === 0);

const abi = attempt([otherAbi]);
check("built for another node: rebuilt once, then opened", abi.result === "db" && abi.rebuilds === 1);

const gone = attempt([missing]);
check("binary missing: rebuilt once, then opened", gone.result === "db" && gone.rebuilds === 1);

const notNative = attempt([badFile]);
check("a bad database file is not a rebuild's business",
  notNative.thrown === badFile && notNative.rebuilds === 0);

const useless = attempt([otherAbi, otherAbi]);
check("a rebuild that did not help: the error shows, no loop",
  useless.thrown === otherAbi && useless.rebuilds === 1);

const noRebuild = attempt([otherAbi], () => {
  throw new Error("npm rebuild: offline");
});
check("a failed rebuild: the original error shows, not npm's",
  noRebuild.thrown === otherAbi && noRebuild.rebuilds === 1);

const soon = attempt([otherAbi], undefined, 9 * MINUTE);
check("nine minutes later: no second rebuild, the error shows",
  soon.thrown === otherAbi && soon.rebuilds === 0);

const later = attempt([otherAbi], undefined, MINUTE);
check("ten minutes later: tried again (the network came back)",
  later.result === "db" && later.rebuilds === 1);

console.log(failed === 0 ? "\nDB TESTS PASSED" : `\n${failed} DB TEST(S) FAILED`);
if (failed > 0) process.exitCode = 1;
