"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  _version: 1,
  enabled: true,
  alertThresholdBytes: 104857600,  // 100 MB
  lastKnownFree: 0,
  autoStart: false,
  firstRunDone: false,
};

// Keys that can be set via .set()
const SETTABLE = new Set([
  "enabled", "alertThresholdBytes", "lastKnownFree", "autoStart", "firstRunDone",
]);

module.exports = function createSettings(userDataPath) {
  const filePath = path.join(userDataPath, "c-drive-guardian-settings.json");
  let data = {};
  let saveTimer = null;

  function load() {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      data = JSON.parse(raw);
      // Merge with defaults (fills missing keys)
      for (const k of Object.keys(DEFAULTS)) {
        if (data[k] === undefined) data[k] = DEFAULTS[k];
      }
    } catch {
      data = { ...DEFAULTS };
    }
    return data;
  }

  function save() {
    // Debounced write
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
      } catch (err) {
        console.warn("[C-Drive Guardian] settings save failed:", err.message);
      }
      saveTimer = null;
    }, 500);
  }

  function get(key) {
    return data[key] !== undefined ? data[key] : DEFAULTS[key];
  }

  function set(key, value) {
    if (!SETTABLE.has(key)) return;
    data[key] = value;
    save();
  }

  function getAll() {
    return { ...data };
  }

  function reset() {
    data = { ...DEFAULTS };
    save();
  }

  // Initialize
  load();

  return { load, get, set, getAll, reset };
};
