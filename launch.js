#!/usr/bin/env node

// Launcher that strips ELECTRON_RUN_AS_NODE before spawning Electron.
// Claude Code sets this variable, which forces Electron to run as a plain
// Node.js process — the browser layer never initializes, so
// require("electron").app would be undefined.

const { spawn } = require("child_process");
const electron = require("electron");

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = process.argv.slice(2);
const child = spawn(electron, ["." /* main.js from package.json */, ...args], {
  stdio: "inherit",
  env,
});

child.on("close", (code) => process.exit(code ?? 0));
