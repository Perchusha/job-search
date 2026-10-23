// The settings window's only bridge to the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jobHunt", {
  get: () => ipcRenderer.invoke("settings:get"),
  save: (settings) => ipcRenderer.invoke("settings:save", settings),
  openNotificationSettings: () => ipcRenderer.invoke("settings:notifications"),
  testNotification: () => ipcRenderer.invoke("settings:test-notification"),
  openLog: () => ipcRenderer.invoke("settings:open-log"),
});
