const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("diskAPI", {
  onShow: (cb) => ipcRenderer.on("disk-bubble:show", (_, data) => cb(data)),
  onHide: (cb) => ipcRenderer.on("disk-bubble:hide", () => cb()),
  clean: (paths) => ipcRenderer.invoke("disk-bubble:clean", paths),
  move: (paths, target) => ipcRenderer.invoke("disk-bubble:move", paths, target),
  dismiss: () => ipcRenderer.invoke("disk-bubble:dismiss"),
  reportHeight: (h) => ipcRenderer.invoke("disk-bubble:height", h),
  markRestartDelete: (paths) => ipcRenderer.invoke("disk-bubble:restart-delete", paths),
});
