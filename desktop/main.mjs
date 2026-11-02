/**
 * main.mjs — the Job Hunt desktop app: a tray icon around the existing
 * dashboard server.
 *
 * The server (src/dashboard.ts) refreshes the boards in the background, but
 * only while it runs — and it ran in a terminal window that got closed after
 * each look. This app keeps it running out of sight:
 *
 *   - starts with Windows (optional) straight into the tray, no window;
 *   - runs the server as a hidden child process (or uses one already running,
 *     e.g. from Job Hunt.bat) and restarts it if it dies;
 *   - shows the dashboard in its own window; closing the window keeps the app
 *     in the tray, "Quit" stops everything;
 *   - notifies: "N new postings" when a refresh finds postings, and a daily
 *     digest "N new postings in the last 24 hours" at a set time, both
 *     outside quiet hours;
 *   - its settings sit in the dashboard's own Settings (avatar menu), through
 *     preload.cjs;
 *   - speaks the dashboard's language, which /api/new-count reports.
 *
 * Nothing about searching or applying lives here — the server does that,
 * exactly as before. The app needs the repo (node_modules, .venv) and Node on
 * PATH; JOBHUNT_REPO or the repo path baked in at build time (build.mjs) says
 * where the repo is.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray } from "electron";
import { execFile, spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, "package.json"), "utf8"));
const REPO = process.env.JOBHUNT_REPO || PKG.jobHunt?.repoDir || join(HERE, "..");
const SMOKE = process.argv.includes("--smoke");
const STARTED_HIDDEN = process.argv.includes("--hidden");

// Toasts are attributed to the app, not "electron.exe". Must equal build.appId
// in package.json — which electron-builder strips from the packaged copy, so it
// cannot be read from there.
const APP_ID = "com.perch.jobhunt";
app.setAppUserModelId(APP_ID);

/* ------------------------------------------------------------------ */
/* Words                                                                */
/* ------------------------------------------------------------------ */

// The dashboard's language, as /api/new-count last said it. English until then, as there.
let lang = "en";

/** "1 новая вакансия, 2 новые вакансии, 5 новых вакансий". */
const newPostingsRu = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "новая вакансия" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? "новые вакансии" : "новых вакансий"}`;
const newPostingsEn = (n) => `${n} new ${n === 1 ? "posting" : "postings"}`;

const WORDS = () => (lang === "ru"
  ? {
      noNode: "Node.js не найден в PATH",
      noRepo: (repo) => `не найден проект: ${repo}`,
      noServer: (why) => `Сервер не запустился: ${why}.`,
      tooltip: (n) => `Job Hunt — новых вакансий: ${n}`,
      open: "Открыть Job Hunt",
      fresh: (n) => `Новые вакансии (${n})`,
      noFresh: "Новых вакансий нет",
      refresh: "Обновить сейчас",
      toastsOff: "⚠ Уведомления Windows выключены…",
      quit: "Выйти",
      postings: newPostingsRu,
      digest: (n) => `За сутки появилось ${newPostingsRu(n)}`,
      testNotification: "Так будут выглядеть уведомления о новых вакансиях.",
    }
  : {
      noNode: "Node.js is not in PATH",
      noRepo: (repo) => `project not found: ${repo}`,
      noServer: (why) => `The server did not start: ${why}.`,
      tooltip: (n) => `Job Hunt — new postings: ${n}`,
      open: "Open Job Hunt",
      fresh: (n) => `New postings (${n})`,
      noFresh: "No new postings",
      refresh: "Refresh now",
      toastsOff: "⚠ Windows notifications are off…",
      quit: "Quit",
      postings: newPostingsEn,
      digest: (n) => `${newPostingsEn(n)} in the last 24 hours`,
      testNotification: "This is how notifications about new postings will look.",
    });

/* ------------------------------------------------------------------ */
/* Settings and state                                                   */
/* ------------------------------------------------------------------ */

const DEFAULTS = {
  autostart: true,
  port: 4321,
  /** Dashboard reachable from phones on the same Wi-Fi (binds 0.0.0.0). */
  lanAccess: false,
  /** How often the fast boards are refreshed, hours. */
  refreshHours: 6,
  /** LinkedIn's daily incremental refresh in the background. */
  linkedinBackground: true,
  /** "N new postings" as soon as a refresh finds some. */
  notifyNew: true,
  /** Do not notify for fewer new postings than this. */
  notifyMin: 1,
  quietFrom: "22:00",
  quietTo: "08:00",
  /** "N new postings in the last 24 hours", once a day. */
  digest: true,
  digestTime: "09:00",
};

const SETTINGS_FILE = () => join(app.getPath("userData"), "settings.json");
const STATE_FILE = () => join(app.getPath("userData"), "state.json");
const LOG_FILE = () => join(app.getPath("userData"), "job-hunt.log");

function readJson(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch {
    return { ...fallback };
  }
}

let settings = DEFAULTS;
let state = { lastNotifiedAt: null, lastDigestDate: null };

function log(message) {
  const line = `${new Date().toISOString()}  ${message}\n`;
  try {
    appendFileSync(LOG_FILE(), line);
  } catch {}
  if (SMOKE) process.stdout.write(line);
}

const base = () => `http://127.0.0.1:${settings.port}`;

/* ------------------------------------------------------------------ */
/* The dashboard server                                                 */
/* ------------------------------------------------------------------ */

let server = null; // the child process, when this app started it
let quitting = false;
let restarts = 0;

async function alive() {
  try {
    const response = await fetch(`${base()}/api/stats`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

/** node.exe from PATH; the packaged app inherits the user's PATH at logon. */
function findNode() {
  return new Promise((resolve) => {
    execFile("where.exe", ["node"], { windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout.split(/\r?\n/).find((line) => line.trim().endsWith("node.exe"))?.trim() ?? null);
    });
  });
}

async function startServer() {
  if (await alive()) {
    log(`using the server already running on ${base()}`);
    return true;
  }
  const node = process.env.JOBHUNT_NODE || (await findNode());
  const tsx = join(REPO, "node_modules", "tsx", "dist", "cli.mjs");
  if (!node || !existsSync(tsx)) {
    const why = !node ? WORDS().noNode : WORDS().noRepo(REPO);
    log(`cannot start the server: ${why}`);
    if (!SMOKE) dialog.showErrorBox("Job Hunt", WORDS().noServer(why));
    return false;
  }
  server = spawn(node, [tsx, join(REPO, "src", "dashboard.ts")], {
    cwd: REPO,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      JOBHUNT_PORT: String(settings.port),
      JOBHUNT_HOST: settings.lanAccess ? "0.0.0.0" : "127.0.0.1",
      JOBHUNT_REFRESH_HOURS: String(settings.refreshHours),
      JOBHUNT_LINKEDIN_BACKGROUND: settings.linkedinBackground ? "1" : "0",
    },
  });
  const pipe = (chunk) => log(`server  ${chunk.toString("utf8").trimEnd()}`);
  server.stdout.on("data", pipe);
  server.stderr.on("data", pipe);
  const child = server;
  child.on("exit", (code) => {
    log(`server exited (${code})`);
    if (server === child) server = null;
    // Keep it alive: a crash should not silently end the background refresh.
    if (!quitting && restarts < 5) {
      restarts++;
      setTimeout(() => void startServer(), 5000);
    }
  });
  for (let waited = 0; waited < 40_000; waited += 500) {
    if (await alive()) {
      log(`server up on ${base()} (pid ${child.pid})`);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  log("server did not answer within 40 s");
  return false;
}

/** tsx runs the dashboard in a child of its own: kill the whole tree. */
function stopServer() {
  return new Promise((resolve) => {
    if (!server?.pid) return resolve();
    const pid = server.pid;
    server = null;
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => resolve());
  });
}

async function restartServer() {
  await stopServer();
  restarts = 0;
  await startServer();
}

/* ------------------------------------------------------------------ */
/* Window, tray                                                         */
/* ------------------------------------------------------------------ */

const ICON = () => nativeImage.createFromPath(join(HERE, "assets", "icon.png"));
let win = null;
let tray = null;
let newCount = 0;

function showWindow(view) {
  if (!win) {
    win = new BrowserWindow({
      width: 1280,
      height: 720,
      title: "Job Hunt",
      icon: ICON(),
      autoHideMenuBar: true,
      show: false,
      // The dashboard's Settings edits this app's settings through this
      // bridge; preload.cjs exposes it only to the local dashboard.
      webPreferences: { preload: join(HERE, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
    });
    // Postings and apply forms open in the real browser, not in this window —
    // and nothing else is ever navigated to in it, so no other page gets the bridge.
    win.webContents.setWindowOpenHandler(({ url }) => {
      void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, url) => {
      if (url.startsWith(`${base()}/`)) return;
      event.preventDefault();
      void shell.openExternal(url);
    });
    win.on("close", (event) => {
      if (quitting) return;
      event.preventDefault(); // closing keeps the app in the tray
      win.hide();
    });
    win.on("closed", () => {
      win = null;
    });
  }
  void win.loadURL(`${base()}/${view ? `#${view}` : ""}`);
  win.once("ready-to-show", () => win?.show());
  if (win.isVisible()) win.focus();
  else win.show();
}

function refreshTray() {
  if (!tray) return;
  tray.setImage(nativeImage.createFromPath(join(HERE, "assets", newCount > 0 ? "tray-new.png" : "tray.png")));
  tray.setToolTip(newCount > 0 ? WORDS().tooltip(newCount) : "Job Hunt");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: WORDS().open, click: () => showWindow() },
      { label: newCount > 0 ? WORDS().fresh(newCount) : WORDS().noFresh, click: () => showWindow("search") },
      { label: WORDS().refresh, click: () => void refreshNow() },
      { type: "separator" },
      ...(toastsOff ? [{ label: WORDS().toastsOff, click: () => void shell.openExternal("ms-settings:notifications") }] : []),
      { label: WORDS().quit, click: () => quit() },
    ]),
  );
}

async function refreshNow() {
  try {
    // ↻ Refresh's own route: the fast boards now, LinkedIn on its pace.
    await fetch(`${base()}/api/search?refresh=1`, { signal: AbortSignal.timeout(120_000) });
  } catch (error) {
    log(`refresh failed: ${error.message}`);
  }
  await checkNew();
}

async function quit() {
  quitting = true;
  await stopServer();
  app.quit();
}

/* ------------------------------------------------------------------ */
/* Notifications                                                        */
/* ------------------------------------------------------------------ */

let toastsOff = false;

/** Windows' own switch for all app notifications (Settings → System → Notifications). */
function readToastSetting() {
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications", "/v", "ToastEnabled"],
      { windowsHide: true },
      (error, stdout) => resolve(!error && /ToastEnabled\s+REG_DWORD\s+0x0\b/.test(stdout)),
    );
  });
}

const minutes = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};

function inQuietHours(now = new Date()) {
  const current = now.getHours() * 60 + now.getMinutes();
  const from = minutes(settings.quietFrom);
  const to = minutes(settings.quietTo);
  return from === to ? false : from < to ? current >= from && current < to : current >= from || current < to;
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const toast = new Notification({ title, body, icon: ICON(), silent: false });
  toast.on("click", () => showWindow("search"));
  toast.show();
  log(`notified: ${title} — ${body.replace(/\n/g, " | ")}`);
}

const saveState = () => writeFileSync(STATE_FILE(), JSON.stringify(state, null, 2));

async function newSince(since) {
  const query = since ? `?since=${encodeURIComponent(since)}` : "";
  const response = await fetch(`${base()}/api/new-count${query}`, { signal: AbortSignal.timeout(10_000) });
  return response.json();
}


/**
 * Every few minutes: the tray badge (new since the Search tab was last
 * opened), a notification for postings first seen since the last one, and
 * the daily digest. Reads the server's stored postings only — it never asks a
 * board.
 */
async function checkNew() {
  // A server this app attached to (Job Hunt.bat) may have been closed since;
  // then start an own one, so the background refresh never quietly stops.
  if (!server && !(await alive())) {
    log("no server answering: starting one");
    restarts = 0;
    await startServer();
  }
  try {
    const sinceVisit = await newSince(null);
    newCount = sinceVisit.count ?? 0;
    if (sinceVisit.language === "ru" || sinceVisit.language === "en") lang = sinceVisit.language;
    refreshTray();

    const now = new Date();
    if (settings.notifyNew) {
      if (!state.lastNotifiedAt) {
        // First run: start counting from now rather than announcing the backlog.
        state.lastNotifiedAt = now.toISOString();
        saveState();
      } else if (!inQuietHours(now)) {
        const fresh = await newSince(state.lastNotifiedAt);
        // Claude is still judging some of them (src/verdict.ts): wait, so a
        // posting it is about to hide is not announced — 15 minutes at most,
        // and without moving lastNotifiedAt, so nothing waiting is skipped.
        const judging = fresh.pending > 0 && now - Date.parse(fresh.pendingSince) < 15 * 60_000;
        if (!judging && fresh.count >= Math.max(1, settings.notifyMin)) {
          notify(WORDS().postings(fresh.count), fresh.top.join("\n"));
          state.lastNotifiedAt = now.toISOString();
          saveState();
        }
      }
    }

    const today = now.toLocaleDateString("sv"); // local YYYY-MM-DD: the digest is a local-time event
    const digestDue = now.getHours() * 60 + now.getMinutes() >= minutes(settings.digestTime);
    if (settings.digest && digestDue && state.lastDigestDate !== today) {
      const day = await newSince(new Date(now.getTime() - 24 * 3_600_000).toISOString());
      state.lastDigestDate = today;
      saveState();
      if (day.count > 0) {
        notify(WORDS().digest(day.count), day.top.join("\n"));
      }
    }
  } catch (error) {
    log(`check failed: ${error.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Autostart, settings IPC                                              */
/* ------------------------------------------------------------------ */

function applyAutostart() {
  // Packaged: the installed exe. Development: electron.exe with this folder.
  app.setLoginItemSettings({
    openAtLogin: Boolean(settings.autostart),
    path: process.execPath,
    args: app.isPackaged ? ["--hidden"] : [app.getAppPath(), "--hidden"],
  });
}

ipcMain.handle("settings:get", () => ({
  settings,
  toastsOff,
  repo: REPO,
  logFile: LOG_FILE(),
  autostartActive: app.getLoginItemSettings({
    path: process.execPath,
    args: app.isPackaged ? ["--hidden"] : [app.getAppPath(), "--hidden"],
  }).openAtLogin,
}));

ipcMain.handle("settings:save", async (_event, next) => {
  const previous = settings;
  settings = { ...DEFAULTS, ...next };
  writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2));
  applyAutostart();
  // The server reads these at start: restart it when one of them changed.
  const serverKeys = ["port", "lanAccess", "refreshHours", "linkedinBackground"];
  if (serverKeys.some((key) => previous[key] !== settings[key])) {
    log("server settings changed: restarting the server");
    await restartServer();
    if (win) showWindow();
  }
  return { ok: true };
});

ipcMain.handle("settings:notifications", () => shell.openExternal("ms-settings:notifications"));
ipcMain.handle("settings:test-notification", () => notify("Job Hunt", WORDS().testNotification));
ipcMain.handle("settings:open-log", () => shell.openPath(LOG_FILE()));

/* ------------------------------------------------------------------ */
/* Start                                                                */
/* ------------------------------------------------------------------ */

if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
  // Closing every window keeps the app in the tray.
  app.on("window-all-closed", () => {});
  app.on("before-quit", () => {
    quitting = true;
  });

  app.whenReady().then(async () => {
    settings = readJson(SETTINGS_FILE(), DEFAULTS);
    state = readJson(STATE_FILE(), state);
    if (process.env.JOBHUNT_PORT) settings.port = Number(process.env.JOBHUNT_PORT);
    log(`starting (repo ${REPO}, packaged ${app.isPackaged}, hidden ${STARTED_HIDDEN})`);

    const up = await startServer();
    if (SMOKE) {
      // `npm run smoke`: server up, one check, report, quit. For tests.
      const report = up ? await newSince(null).catch((error) => ({ error: error.message })) : { error: "server down" };
      process.stdout.write(`SMOKE ${JSON.stringify({ up, base: base(), newCount: report })}\n`);
      await quit();
      return;
    }

    if (!app.isPackaged && !existsSync(SETTINGS_FILE())) settings.autostart = false; // no autostart for a dev checkout by default
    applyAutostart();
    toastsOff = await readToastSetting();
    tray = new Tray(nativeImage.createFromPath(join(HERE, "assets", "tray.png")));
    tray.on("double-click", () => showWindow());
    tray.on("click", () => showWindow());
    refreshTray();
    if (!STARTED_HIDDEN) showWindow();

    await checkNew();
    setInterval(() => void checkNew(), 5 * 60_000);
  });
}
