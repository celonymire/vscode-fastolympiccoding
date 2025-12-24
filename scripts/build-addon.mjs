#!/usr/bin/env node
/**
 * Cross-platform wrapper for building the optional native addon.
 *
 * - On Windows: runs `node-gyp rebuild` (passes through args).
 * - On other platforms: no-op (exit 0).
 *
 * Usage examples:
 *   node scripts/build-addon.mjs
 *   node scripts/build-addon.mjs rebuild
 *   node scripts/build-addon.mjs rebuild --release
 *   node scripts/build-addon.mjs clean
 */

import { spawn } from "node:child_process";

const platform = process.platform;
const args = process.argv.slice(2);

// Default to "rebuild" if no args are provided.
const nodeGypArgs = args.length > 0 ? args : ["rebuild"];

if (platform !== "win32") {
  console.log(`[build-addon] Skipping native addon build (platform=${platform}).`);
  process.exit(0);
}

// Use npx to avoid relying on global installs and to respect local devDependencies.
const cmd = "npx";
const cmdArgs = ["--no", "node-gyp", ...nodeGypArgs];

console.log(`[build-addon] Building native addon via: ${cmd} ${cmdArgs.join(" ")}`);

const child = spawn(cmd, cmdArgs, {
  stdio: "inherit",
  shell: process.platform === "win32",
});

child.on("error", (err) => {
  console.warn(`[build-addon] Failed to spawn build process: ${err?.message ?? String(err)}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.warn(`[build-addon] Build terminated by signal: ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
