"use strict";

// ── C-Drive Guardian — Main Entry ──
// System tray app: monitors C: drive space, shows bubble alerts on changes.

const { app, Tray, Menu, nativeImage, ipcMain, dialog } = require("electron");
const path = require("path");

const DiskMonitor = require("./monitor");
const createSettings = require("./settings");

const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GB = BYTES_PER_MB * 1024;

// ── State ──
let tray = null;
let monitor = null;
let settings = null;

// ── Paths ──
const TRAY_ICON = path.join(__dirname, "..", "assets", "tray-icon.png");

// ── Helpers ──

function formatBytes(bytes) {
  if (bytes >= BYTES_PER_GB) return (bytes / BYTES_PER_GB).toFixed(1) + " GB";
  return (bytes / BYTES_PER_MB).toFixed(0) + " MB";
}

// ── Tray ──

function createTray() {
  const icon = nativeImage.createFromPath(TRAY_ICON);
  tray = new Tray(icon);
  tray.setToolTip("C-Drive Guardian — C 盘卫士");
  rebuildTrayMenu();
}

function rebuildTrayMenu() {
  if (!tray) return;

  const status = monitor ? monitor.getStatus() : { enabled: false };
  const base = template(status);
  tray.setContextMenu(Menu.buildFromTemplate(base));
}

function template(status) {
  const isActive = !!(monitor && status.enabled);

  const items = [];

  items.push({
    label: "C-Drive Guardian — C 盘卫士",
    enabled: false,
  });
  items.push({ type: "separator" });

  // Status
  items.push({
    label: isActive ? "● 监控中" : "○ 已停止",
    enabled: false,
  });
  items.push({ type: "separator" });

  // Toggle
  items.push({
    label: isActive ? "停止监控" : "开始监控",
    click: toggleMonitoring,
  });

  // Scan now
  items.push({
    label: "立即扫描",
    enabled: isActive,
    click: () => {
      if (monitor) monitor.emit("manual-scan");
    },
  });
  items.push({ type: "separator" });

  // Free space
  const freeB = status.lastKnownFree || 0;
  items.push({
    label: "剩余空间：" + formatBytes(freeB),
    enabled: false,
  });
  items.push({ type: "separator" });

  // Auto-start
  const autoStart = app.getLoginItemSettings().openAtLogin;
  items.push({
    label: "开机自启",
    type: "checkbox",
    checked: autoStart,
    click: (e) => toggleAutoStart(e.checked),
  });

  items.push({ type: "separator" });

  // About
  items.push({
    label: "关于 C-Drive Guardian",
    click: showAbout,
  });

  // Quit
  items.push({
    label: "退出",
    click: () => {
      if (monitor) { monitor.cleanup(); monitor = null; }
      app.quit();
    },
  });

  return items;
}

// ── Actions ──

function toggleMonitoring() {
  if (monitor && monitor.getStatus().enabled) {
    monitor.stop();
    monitor.cleanup();
    monitor = null;
    settings.set("enabled", false);
  } else {
    createMonitor();
    settings.set("enabled", true);
  }
  rebuildTrayMenu();
}

function toggleAutoStart(enabled) {
  app.setLoginItemSettings({ openAtLogin: enabled });
  settings.set("autoStart", enabled);
  rebuildTrayMenu();
}

// ── Monitor bootstrap ──

function createMonitor() {
  if (monitor) { monitor.cleanup(); monitor = null; }

  monitor = new DiskMonitor(settings);

  monitor.on("alert", () => {
    rebuildTrayMenu();
  });

  monitor.on("free-space-changed", ({ freeBytes, totalBytes }) => {
    settings.set("lastKnownFree", freeBytes);
    if (tray) {
      tray.setToolTip("C-Drive Guardian\nC 盘剩余 " + formatBytes(freeBytes) + " / " + formatBytes(totalBytes));
    }
    rebuildTrayMenu();
  });

  monitor.on("error", ({ message, source }) => {
    console.error("[C-Drive Guardian]", source + ":", message);
  });

  monitor.on("manual-scan", async () => {
    const files = await monitor.queryChangedFiles(3);
    if (files.length > 0) {
      const payload = monitor.buildAlertPayload(0, files, "stable");
      monitor.showBubbleWindow(payload);
    }
  });

  monitor.registerIpc();
  monitor.start();
}

// ── IPC (for potential future settings window) ──

function registerIpcMain() {
  ipcMain.handle("cdisk:get-status", () => ({
    monitor: monitor ? monitor.getStatus() : { enabled: false },
    settings: settings.getAll(),
    autoStart: app.getLoginItemSettings().openAtLogin,
  }));

  ipcMain.handle("cdisk:toggle-monitor", () => {
    toggleMonitoring();
    return settings.get("enabled");
  });
}

// ── Dialogs ──

function showAbout() {
  dialog.showMessageBox({
    type: "info",
    title: "关于 C-Drive Guardian",
    message: "C-Drive Guardian — C 盘卫士",
    detail: "版本 " + app.getVersion() + "\n\n"
      + "实时监控 C 盘空间变化，自动识别可清理文件。\n"
      + "基于 NTFS USN 日记，低功耗精准定位变化文件。\n\n"
      + "技术栈：Electron + Node.js\n"
      + "协议：AGPL-3.0",
    buttons: ["确定"],
  });
}

function showFirstRunDialog() {
  dialog.showMessageBox({
    type: "info",
    title: "欢迎使用 C-Drive Guardian",
    message: "C 盘卫士已开始运行",
    detail: "它会在系统托盘中后台运行，检测到 C 盘空间变化时弹窗通知。\n\n"
      + "右键托盘图标可访问设置。\n"
      + "监控默认自动启动。",
    buttons: ["知道了"],
  });
}

// ── App lifecycle ──

app.whenReady().then(() => {
  app.setAppUserModelId("com.cdriveguardian.app");
  // Init settings
  settings = createSettings(app.getPath("userData"));

  // Init tray
  createTray();

  // Sync auto-start from saved preference
  if (settings.get("autoStart")) {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  // Start monitor if enabled
  if (settings.get("enabled") && process.platform === "win32") {
    createMonitor();
  }

  // First-run dialog
  if (!settings.get("firstRunDone")) {
    showFirstRunDialog();
    settings.set("firstRunDone", true);
  }

  // IPC
  registerIpcMain();

  console.log("[C-Drive Guardian] started");
});

// Don't quit on window close (tray app)
app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  if (monitor) { monitor.cleanup(); monitor = null; }
});

app.on("will-quit", () => {
  if (tray) { tray.destroy(); tray = null; }
});
