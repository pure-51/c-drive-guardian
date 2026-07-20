"use strict";

// ── C-Drive Guardian — Disk Monitor Module ──
//
// Architecture (unchanged from original core logic):
//   ① Disk-space polling (30s) → detects total space change
//   ② Hotspot file scanner     → locates changed files (Temp, Cache, Downloads, …)
//   ③ Classification + risk    → per-file category + lock check
//   ④ Dual notification        → "stable-1min" + "every-500MB"
//   ⑤ Bubble window            → transparent overlay with action buttons
//   ⑥ Cleanup executor         → delete / move / report

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { ipcMain, dialog, BrowserWindow, screen } = require("electron");

const POLL_INTERVAL_MS = 30_000;
const STABLE_WAIT_MS = 60_000;
const INCREMENTAL_THRESHOLD_MB = 500;
const SCAN_TIMEOUT_MS = 15_000;
const SCAN_COOLDOWN_MS = 120_000;
const CHANGE_LOG_MAX = 48;
const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_THRESHOLD = BigInt(INCREMENTAL_THRESHOLD_MB) * BigInt(BYTES_PER_MB);

class DiskMonitor extends EventEmitter {
  constructor(settings) {
    super();
    this.settings = settings;
    this.isWin = process.platform === "win32";
    this.execFile = require("child_process").execFile;
    this.logWarn = console.warn;

    // State
    this.pollTimer = null;
    this.stableTimer = null;
    this.scanning = false;
    this.lastScanAt = 0;
    this.lastKnownFree = 0;
    this.lastKnownTotal = 0;
    this.cumulativeDeltaBytes = 0;
    this.lastChangeAt = 0;
    this.changeLog = [];
    this.running = false;
    this.bubbleWindow = null;
    this.scanInProgress = false;
    this._lastScannedFiles = [];
    this._lastScanDelta = 0;
  }

  // ── PowerShell ──

  runPowershell(script) {
    return new Promise((resolve) => {
      const child = this.execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { timeout: SCAN_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) { resolve(null); return; }
          resolve(stdout.trim());
        }
      );
    });
  }

  // ── ① Disk-space query ──

  async queryDiskSpace() {
    const script =
      '$drv=Get-PSDrive -Name C; try { $used = $drv.Used -as [long] } catch { $used = $drv.Size - $drv.Free };' +
      'Write-Output (ConvertTo-Json @{Total=($drv.Size -as [long]); Free=($drv.Free -as [long]); Used=($used -as [long])})';
    const raw = await this.runPowershell(script);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return {
        totalBytes: parsed.Total || 0,
        freeBytes: parsed.Free || 0,
        usedBytes: parsed.Used || (parsed.Total - parsed.Free),
        timestamp: Date.now(),
      };
    } catch {
      return null;
    }
  }

  // ── ② File scanner ──

  async queryChangedFiles(sinceMinutes = 2) {
    const cutoffDate = new Date(Date.now() - sinceMinutes * 60_000).toISOString();
    const script =
      'function q($p,$d) { try { return Get-ChildItem $p -Recurse -File -ErrorAction Stop -Depth $d } catch { return @() } };' +
      '$cut=[datetime]"' + cutoffDate + '";' +
      '$r=@();' +
      'foreach($d in @($env:TEMP,"$env:LOCALAPPDATA\\Temp","$env:USERPROFILE\\Downloads","$env:LOCALAPPDATA\\Microsoft\\Windows\\INetCache","$env:USERPROFILE\\.cache")){' +
        'if(Test-Path $d){$r+=q $d 2 | ?{$_.LastWriteTime -gt $cut -and $_.FullName -like \"C:\\*\"}}}' +
      '$r+=Get-ChildItem C:\\ -File -ErrorAction SilentlyContinue | ?{$_.LastWriteTime -gt $cut -and $_.Length -gt 10MB};' +
      '$r | Group FullName | %{$_.Group[0]} | Sort Length -Descending | Select -First 50 FullName,Length,LastWriteTime,Extension,DirectoryName | ConvertTo-Json -Compress';
    const raw = await this.runPowershell(script);
    if (!raw) return [];
    try {
      const items = JSON.parse(raw);
      return Array.isArray(items) ? items : [items];
    } catch {
      return [];
    }
  }

  // ── ③ Classification + risk analysis ──

  classifyFile(file) {
    const fpath = (file.FullName || file.fullName || "").toLowerCase();
    const ext = (file.Extension || ".tmp").toLowerCase();
    const dir = (file.DirectoryName || "").toLowerCase();
    const size = file.Length || file.length || 0;

    if (/\\temp\\/i.test(fpath) || /\\tmp\\/i.test(fpath)) {
      return { cat: "temp", action: "delete_safe", risk: "临时文件，可安全删除", canDelete: true, canMove: false, label: "临时文件" };
    }
    if (/\\cache\\/i.test(fpath) || /\\.cache\\/i.test(fpath) || /\\inetcache\\/i.test(fpath)) {
      return { cat: "cache", action: "delete_safe", risk: "缓存文件，删除不影响运行", canDelete: true, canMove: false, label: "缓存文件" };
    }
    if (ext === ".log" || ext === ".tmp") {
      return { cat: "log", action: "delete_safe", risk: ext === ".log" ? "日志文件，可安全删除" : "临时文件，可安全删除", canDelete: true, canMove: false, label: ext === ".log" ? "日志文件" : "临时文件" };
    }
    if (/^c:\\windows(\\|$)/i.test(fpath) || /^c:\\program\s?files/i.test(fpath)
        || /^c:\\programdata/i.test(fpath) || /^c:\\system volume information/i.test(fpath)
        || /^c:\\\$recycle\.bin/i.test(fpath)) {
      return { cat: "system", action: "skip", risk: "系统文件，不可操作", canDelete: false, canMove: false, label: "系统文件" };
    }
    if (/\\downloads\\/i.test(dir)) {
      return { cat: "download", action: "move_ask", risk: "用户下载文件，建议确认后移动", canDelete: false, canMove: true, label: "下载文件" };
    }
    if (/\\google\\\w+\\user data/i.test(fpath) || (/\\microsoft\\edge\\/i.test(fpath) && /\\cache\\/i.test(fpath))
        || /\\mozilla\\firefox/i.test(fpath)) {
      return { cat: "cache", action: "delete_safe", risk: "浏览器缓存文件，可安全删除", canDelete: true, canMove: false, label: "浏览器缓存" };
    }
    if (/\.exe$/i.test(ext) && /\\temp\\/i.test(fpath)) {
      return { cat: "temp", action: "delete_safe", risk: "安装程序临时文件", canDelete: true, canMove: false, label: "安装缓存" };
    }
    if (/\\npm[-_]cache/i.test(fpath) || /\\pip\\/i.test(fpath) || /\\yarn\\/i.test(fpath)) {
      return { cat: "cache", action: "delete_safe", risk: "包管理器缓存，可安全删除", canDelete: true, canMove: false, label: "包管理器缓存" };
    }
    return { cat: "unknown", action: "notify_only", risk: "未知来源，仅通知", canDelete: false, canMove: false, label: "其他文件" };
  }

  findLockingProcess(filePath) {
    return new Promise((resolve) => {
      const handlePath = path.join(__dirname, "..", "bin", "handle64.exe");
      if (!fs.existsSync(handlePath)) return resolve(null);
      const child = this.execFile(
        handlePath,
        ["-accepteula", "-nobanner", "-a", filePath],
        { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err || !stdout) return resolve(null);
          const m = stdout.match(/(S+).exes+pid:s*(d+)/i);
          if (m) resolve({ name: m[1] + ".exe", pid: parseInt(m[2]) });
          else resolve(null);
        }
      );
      setTimeout(() => { try { child.kill(); resolve(null); } catch {} }, 5000);
    });
  }

  async checkFileLock(filePath) {
    try {
      const fd = fs.openSync(filePath, "wx");
      fs.closeSync(fd);
      return { locked: false };
    } catch (err) {
      if (err.code === "EBUSY" || err.code === "EACCES") {
        const proc = await this.findLockingProcess(filePath);
        if (proc) {
          return { locked: true, by: proc.name + "(" + proc.pid + ")", processName: proc.name, pid: proc.pid };
        }
        return { locked: true, by: "另一个进程正在使用" };
      }
      return { locked: false };
    }
  }

  // ── Restart-delete (方案 A 保底) ──

  async registerRestartDelete(filePaths) {
    if (!Array.isArray(filePaths) || filePaths.length === 0) return { ok: false, reason: "no files" };
    const entries = filePaths.map(f => "'\??\\" + f.replace(///g, "\\") + "'").join(",");
    const script =
      'try {  = "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager";' +
      ' = (Get-ItemProperty -Path  -Name PendingFileRenameOperations -ErrorAction SilentlyContinue).PendingFileRenameOperations;' +
      ' = @(); if () {  +=  }; ' +
      " += [string[]]@(" + entries + ", ''); " +
      'Set-ItemProperty -Path  -Name PendingFileRenameOperations -Value ; ' +
      "Write-Output 'OK' } catch { Write-Output ('FAIL:'+/e/Projects/c-drive-guardian.Exception.Message) }";
    const raw = await this.runPowershell(script);
    return { ok: !!raw && raw === "OK", raw };
  }

  // ── ④ Notification ──

  async buildAlertPayload(deltaBytes, files, reason) {
    const deltaMB = Math.round(deltaBytes / BYTES_PER_MB);
    const totalCleanable = files.filter(f => f.canDelete).reduce((s, f) => s + (f.Length || 0), 0);
    const totalMovable = files.filter(f => f.canMove).reduce((s, f) => s + (f.Length || 0), 0);
    return {
      type: "disk-alert",
      deltaMB,
      deltaBytes,
      totalCleanable,
      totalMovable,
      files: files.map(f => ({
        path: f.FullName || f.fullName,
        size: f.Length || f.length || 0,
        extension: f.Extension || "",
        ...this.classifyFile(f),
        locked: (await this.checkFileLock()).locked,
      })),
      reason,       // "stable" | "incremental"
      timestamp: Date.now(),
    };
  }

  // ── Bubble window ──

  showBubbleWindow(payload) {
    try {
      if (this.bubbleWindow && !this.bubbleWindow.isDestroyed()) {
        this.bubbleWindow.webContents.send("disk-bubble:show", payload);
        return;
      }

      this.bubbleWindow = new BrowserWindow({
        width: 380,
        height: 200,
        show: false,
        frame: false,
        transparent: true,
        alwaysOnTop: !(process.platform === "darwin"),
        resizable: false,
        skipTaskbar: true,
        hasShadow: false,
        webPreferences: {
          preload: path.join(__dirname, "preload-bubble.js"),
          nodeIntegration: false,
          contextIsolation: true,
        },
      });

      this.bubbleWindow.loadFile(path.join(__dirname, "bubble.html"));

      this.bubbleWindow.webContents.on("did-finish-load", () => {
        this.positionBubbleWindow();
        this.bubbleWindow.showInactive();
        this.bubbleWindow.webContents.send("disk-bubble:show", payload);
      });

      this.bubbleWindow.on("closed", () => {
        this.bubbleWindow = null;
      });
    } catch (err) {
      this.logWarn("[C-Drive Guardian] bubble window failed:", err && err.message);
    }
  }

  hideBubbleWindow() {
    if (!this.bubbleWindow || this.bubbleWindow.isDestroyed()) return;
    try { this.bubbleWindow.close(); } catch {}
    this.bubbleWindow = null;
  }

  positionBubbleWindow() {
    try {
      const displays = screen.getPrimaryDisplay();
      const targetX = displays.workArea.x + displays.workArea.width - 388;
      const targetY = displays.workArea.y + displays.workArea.height - 208;
      this.bubbleWindow.setBounds({ x: targetX, y: targetY, width: 380, height: 200 });
    } catch {}
  }

  // ── ⑤ Main polling ──

  async poll() {
    if (!this.running) return;
    const space = await this.queryDiskSpace();
    if (!space) return;

    const { totalBytes, freeBytes } = space;
    if (this.lastKnownTotal === 0) this.lastKnownTotal = totalBytes;

    if (this.lastKnownFree === 0) {
      this.lastKnownFree = freeBytes;
      this.emit("free-space-changed", { freeBytes, totalBytes });
      return;
    }

    const delta = this.lastKnownFree - freeBytes;
    const absDelta = Math.abs(delta);

    if (delta > 0) {
      this.cumulativeDeltaBytes += absDelta;
      this.lastChangeAt = Date.now();

      this.changeLog.push({ at: Date.now(), deltaBytes: absDelta, freeBytes });
      if (this.changeLog.length > CHANGE_LOG_MAX) this.changeLog.shift();

      this.triggerScan(delta);

      // Incremental threshold check
      if (this.cumulativeDeltaBytes >= Number(BYTES_PER_THRESHOLD)) {
        this.queryChangedFiles(5).then(files => {
          const payload = await this.buildAlertPayload(this.cumulativeDeltaBytes, files, "incremental");
          this.showBubbleWindow(payload);
          this.emit("alert", payload);
        });
        this.cumulativeDeltaBytes = (this.cumulativeDeltaBytes % Number(BYTES_PER_THRESHOLD));
      }

      // Reset stable timer
      if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        if (this.lastChangeAt > 0 && (Date.now() - this.lastChangeAt) >= STABLE_WAIT_MS) {
          this.triggerNotification("stable", delta);
        }
      }, STABLE_WAIT_MS);

    } else if (delta < 0) {
      this.changeLog.push({ at: Date.now(), deltaBytes: -absDelta, freeBytes });
      if (this.changeLog.length > CHANGE_LOG_MAX) this.changeLog.shift();
    }

    this.lastKnownFree = freeBytes;
    this.emit("free-space-changed", { freeBytes, totalBytes });
  }

  async triggerScan(deltaBytes) {
    const now = Date.now();
    if (this.scanInProgress) return;
    if (now - this.lastScanAt < SCAN_COOLDOWN_MS) return;
    this.scanInProgress = true;
    this.lastScanAt = now;
    try {
      const files = await this.queryChangedFiles(3);
      if (files.length > 0) {
        this._lastScannedFiles = files;
        this._lastScanDelta = deltaBytes;
      }
    } catch {} finally {
      this.scanInProgress = false;
    }
  }

  async triggerNotification(reason, deltaBytes) {
    const files = this._lastScannedFiles.length > 0
      ? this._lastScannedFiles
      : await this.queryChangedFiles(5);
    if (files.length === 0 && this.cumulativeDeltaBytes < Number(BYTES_PER_THRESHOLD)) return;
    const payload = await this.buildAlertPayload(
      reason === "stable" ? this.cumulativeDeltaBytes : deltaBytes,
      files,
      reason
    );
    this.showBubbleWindow(payload);
    this.emit("alert", payload);
    if (reason === "stable") {
      this.cumulativeDeltaBytes = 0;
    }
  }

  // ── ⑥ Cleanup executor ──

  executeClean(filePaths) {
    if (!Array.isArray(filePaths)) return { deleted: 0, failed: 0, freed: 0 };
    let deleted = 0, failed = 0, freed = 0;
    for (const fp of filePaths) {
      try {
        const stat = fs.statSync(fp);
        fs.unlinkSync(fp);
        deleted++;
        freed += stat.size;
      } catch (err) {
        failed++;
        this.logWarn("[C-Drive Guardian] clean failed:", fp, err && err.message);
      }
    }
    return { deleted, failed, freed };
  }

  executeMove(filePaths, targetDir) {
    if (!Array.isArray(filePaths) || !targetDir) return { moved: 0, failed: 0 };
    try { fs.mkdirSync(targetDir, { recursive: true }); } catch {}
    let moved = 0, failed = 0;
    for (const fp of filePaths) {
      try {
        const name = path.basename(fp);
        fs.renameSync(fp, path.join(targetDir, name));
        moved++;
      } catch (err) {
        try {
          const name = path.basename(fp);
          const dest = path.join(targetDir, name);
          fs.copyFileSync(fp, dest);
          fs.unlinkSync(fp);
          moved++;
        } catch {
          failed++;
          this.logWarn("[C-Drive Guardian] move failed:", fp, err && err.message);
        }
      }
    }
    return { moved, failed };
  }

  executeDismiss() {
    this.cumulativeDeltaBytes = 0;
    this.lastChangeAt = 0;
    if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
  }

  // ── IPC registration ──

  registerIpc() {
    const cleanupFns = [];

    // Bubble IPC (kept as disk-bubble:* to match preload-bubble.js)
    cleanupFns.push(ipcMain.handle("disk-bubble:clean", (_event, filePaths) => {
      if (!Array.isArray(filePaths) || filePaths.length === 0) return { deleted: 0, failed: 0, freed: 0 };
      return this.executeClean(filePaths);
    }));

    cleanupFns.push(ipcMain.handle("disk-bubble:move", async (_event, filePaths) => {
      const result = await dialog.showOpenDialog({
        title: "选择目标文件夹",
        properties: ["openDirectory", "createDirectory"],
      });
      if (result.canceled || !result.filePaths.length) return { cancelled: true };
      return this.executeMove(filePaths, result.filePaths[0]);
    }));

    cleanupFns.push(ipcMain.handle("disk-bubble:dismiss", () => {
      this.executeDismiss();
      this.hideBubbleWindow();
      return { ok: true };
    }));

    cleanupFns.push(ipcMain.handle("disk-bubble:height", (_event, h) => {
      if (this.bubbleWindow && !this.bubbleWindow.isDestroyed() && typeof h === "number" && h > 50) {
        try { this.bubbleWindow.setBounds({ ...this.bubbleWindow.getBounds(), height: h }); } catch {}
      }
    }));

    cleanupFns.push(ipcMain.handle("disk-bubble:restart-delete", async (_event, filePaths) => {
      return this.registerRestartDelete(filePaths);
    }));

    return () => {
      for (const fn of cleanupFns) { try { fn(); } catch {} }
    };
  }

  // ── Lifecycle ──

  start() {
    if (this.running || !this.isWin) return;
    this.running = true;
    this.lastKnownFree = this.settings.get("lastKnownFree") || 0;
    this.cumulativeDeltaBytes = 0;
    this.lastChangeAt = 0;
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    this.poll().catch(err => this.logWarn("[C-Drive Guardian] initial poll failed:", err && err.message));
  }

  stop() {
    this.running = false;
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.stableTimer) { clearTimeout(this.stableTimer); this.stableTimer = null; }
    this.cumulativeDeltaBytes = 0;
    this._lastScannedFiles = [];
  }

  cleanup() {
    this.stop();
    this.hideBubbleWindow();
    this.changeLog = [];
  }

  getStatus() {
    return {
      enabled: this.running,
      lastKnownFree: this.lastKnownFree,
      lastChangeAt: this.lastChangeAt > 0 ? new Date(this.lastChangeAt).toISOString() : null,
      pendingDeltaMB: Math.round(this.cumulativeDeltaBytes / BYTES_PER_MB),
      changeLogSize: this.changeLog.length,
    };
  }
}

module.exports = DiskMonitor;
