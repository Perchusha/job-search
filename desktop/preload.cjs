// The bridge between this app's settings (main process) and the page that
// edits them: the dashboard's Settings. Exposed to the local dashboard only —
// the window never navigates elsewhere (main.mjs), and this is the second lock.
const { contextBridge, ipcRenderer } = require("electron");

const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(location.origin);

if (local) {
  contextBridge.exposeInMainWorld("jobHunt", {
    get: () => ipcRenderer.invoke("settings:get"),
    save: (settings) => ipcRenderer.invoke("settings:save", settings),
    openNotificationSettings: () => ipcRenderer.invoke("settings:notifications"),
    testNotification: () => ipcRenderer.invoke("settings:test-notification"),
    openLog: () => ipcRenderer.invoke("settings:open-log"),
  });
}
