import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as path from "node:path";
import * as vscode from "vscode";

import pidusage from "pidusage";

import { getFileRunSettings, ReadonlyTerminal } from "./vscode";
import { getLogger } from "./logging";
import type { Status } from "../../shared/enums";
import type { LanguageSettings } from "../../shared/schemas";

function arrayEquals<T>(a: T[], b: T[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  return a.every((value, index) => value === b[index]);
}

type Win32MemoryAddon = {
  getWin32MemoryStats: (pid: number) => { rss: number; peakRss: number };
};

type LinuxMemoryAddon = {
  getLinuxMemoryStats: (pid: number) => { rss: number; peakRss: number };
};

type Win32TimesAddon = {
  getWin32ProcessTimes: (pid: number) => { elapsedMs: number; cpuMs: number };
};

type LinuxTimesAddon = {
  getLinuxProcessTimes: (pid: number) => { elapsedMs: number; cpuMs: number };
};

type DarwinTimesAddon = {
  getDarwinProcessTimes: (pid: number) => { elapsedMs: number; cpuMs: number };
};

// ============================================================================
// RunSession API Types
// ============================================================================

export type RunTermination =
  | "error" // process exited with non-zero code (or early abort with null code)
  | "timeout" // killed by timeout
  | "memory" // killed by memory limit
  | "stopped" // stopped by caller
  | "exit" // normal exit (zero exit code)
  | "signal"; // killed by OS signal

export function terminationSeverityNumber(termination: RunTermination): number {
  switch (termination) {
    case "exit":
      return 0;
    case "stopped":
      return 1;
    case "error":
      return 2;
    case "signal":
      return 3;
    case "memory":
      return 4;
    case "timeout":
      return 5;
  }
}

export function severityNumberToStatus(severity: number): Status {
  switch (severity) {
    case 0:
    case 1:
      return "AC";
    case 2:
      return "WA";
    case 3:
      return "RE";
    case 4:
      return "ML";
    case 5:
      return "TL";
    default:
      return "RE";
  }
}

export function mapCompilationTermination(termination: RunTermination): Status {
  switch (termination) {
    case "timeout":
      return "TL";
    case "memory":
      return "ML";
    case "stopped":
      return "NA";
    case "error":
      return "CE";
    case "signal":
      return "RE";
    case "exit":
      return "NA";
    default:
      return "RE";
  }
}

export function mapTestcaseTermination(termination: RunTermination): Status {
  switch (termination) {
    case "timeout":
      return "TL";
    case "memory":
      return "ML";
    case "stopped":
      return "NA";
    case "error":
      return "RE";
    case "signal":
      return "RE";
    case "exit":
      return "NA";
    default:
      return "RE";
  }
}

let win32MemoryAddon: Win32MemoryAddon | null = null;

function getWin32MemoryAddon(): Win32MemoryAddon | null {
  if (win32MemoryAddon !== null) {
    return win32MemoryAddon;
  }

  try {
    // Load from the bundled native addon in dist/
    const addonPath = path.join(__dirname, "win32-memory-stats.node");
    if (!fs.existsSync(addonPath)) {
      return null;
    }

    // IMPORTANT: use Node's real require; bundlers like rspack/webpack can rewrite `require()`.
    const nodeRequire = createRequire(__filename);
    const loaded: unknown = nodeRequire(addonPath);

    if (loaded && typeof loaded === "object" && "getWin32MemoryStats" in loaded) {
      win32MemoryAddon = loaded as Win32MemoryAddon;
      return win32MemoryAddon;
    }

    return null;
  } catch (err) {
    const logger = getLogger("runtime");
    logger.warn(
      `Windows memory addon unavailable, using pidusage fallback (performance degraded): ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

let linuxMemoryAddon: LinuxMemoryAddon | null = null;

function getLinuxMemoryAddon(): LinuxMemoryAddon | null {
  if (linuxMemoryAddon !== null) {
    return linuxMemoryAddon;
  }

  try {
    // Load from the bundled native addon in dist/
    const addonPath = path.join(__dirname, "linux-memory-stats.node");
    if (!fs.existsSync(addonPath)) {
      return null;
    }

    // IMPORTANT: use Node's real require; bundlers like rspack/webpack can rewrite `require()`.
    const nodeRequire = createRequire(__filename);
    const loaded: unknown = nodeRequire(addonPath);

    if (loaded && typeof loaded === "object" && "getLinuxMemoryStats" in loaded) {
      linuxMemoryAddon = loaded as LinuxMemoryAddon;
      return linuxMemoryAddon;
    }

    return null;
  } catch (err) {
    const logger = getLogger("runtime");
    logger.warn(
      `Linux memory addon unavailable, using pidusage fallback (performance degraded): ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

let win32TimesAddon: Win32TimesAddon | null = null;

function getWin32TimesAddon(): Win32TimesAddon | null {
  if (win32TimesAddon !== null) {
    return win32TimesAddon;
  }

  try {
    const addonPath = path.join(__dirname, "win32-process-times.node");
    if (!fs.existsSync(addonPath)) {
      return null;
    }

    const nodeRequire = createRequire(__filename);
    const loaded: unknown = nodeRequire(addonPath);

    if (loaded && typeof loaded === "object" && "getWin32ProcessTimes" in loaded) {
      win32TimesAddon = loaded as Win32TimesAddon;
      return win32TimesAddon;
    }

    return null;
  } catch (err) {
    const logger = getLogger("runtime");
    logger.warn(
      `Windows timing addon unavailable, using hrtime fallback: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

let linuxTimesAddon: LinuxTimesAddon | null = null;

function getLinuxTimesAddon(): LinuxTimesAddon | null {
  if (linuxTimesAddon !== null) {
    return linuxTimesAddon;
  }

  try {
    const addonPath = path.join(__dirname, "linux-process-times.node");
    if (!fs.existsSync(addonPath)) {
      return null;
    }

    const nodeRequire = createRequire(__filename);
    const loaded: unknown = nodeRequire(addonPath);

    if (loaded && typeof loaded === "object" && "getLinuxProcessTimes" in loaded) {
      linuxTimesAddon = loaded as LinuxTimesAddon;
      return linuxTimesAddon;
    }

    return null;
  } catch (err) {
    const logger = getLogger("runtime");
    logger.warn(
      `Linux timing addon unavailable, using hrtime fallback: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

let darwinTimesAddon: DarwinTimesAddon | null = null;

function getDarwinTimesAddon(): DarwinTimesAddon | null {
  if (darwinTimesAddon !== null) {
    return darwinTimesAddon;
  }

  try {
    const addonPath = path.join(__dirname, "darwin-process-times.node");
    if (!fs.existsSync(addonPath)) {
      return null;
    }

    const nodeRequire = createRequire(__filename);
    const loaded: unknown = nodeRequire(addonPath);

    if (loaded && typeof loaded === "object" && "getDarwinProcessTimes" in loaded) {
      darwinTimesAddon = loaded as DarwinTimesAddon;
      return darwinTimesAddon;
    }

    return null;
  } catch (err) {
    const logger = getLogger("runtime");
    logger.warn(
      `macOS timing addon unavailable, using hrtime fallback: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

// ============================================================================
// Runnable - Process runner with session-based listener API
// ============================================================================

type ListenerCallback =
  | (() => void)
  | ((data: string) => void)
  | ((data: string | Error) => void)
  | ((code: number | null, signal: NodeJS.Signals | null) => void)
  | ((err: Error) => void);

export class Runnable {
  // Use a short interval to get more accurate peak memory usage.
  private static readonly MEMORY_SAMPLE_INTERVAL_MS = 100;

  private static readonly BYTES_PER_MEGABYTE = 1024 * 1024;

  private _process: childProcess.ChildProcessWithoutNullStreams | undefined = undefined;
  private _promise: Promise<void> | undefined = undefined;
  private _spawnPromise: Promise<boolean> | undefined = undefined;
  private _elapsed = 0;
  private _signal: NodeJS.Signals | null = null;
  private _abortController: AbortController | null = null;
  private _combinedAbortSignal: AbortSignal | null = null;
  private _timedOut = false;
  private _exitCode: number | null = 0;
  private _memoryCancellationTokenSource: vscode.CancellationTokenSource | null = null;
  private _memorySampleTimeout: NodeJS.Timeout | null = null;
  private _maxMemoryBytes = 0;
  private _memoryLimitBytes = 0;
  private _memoryLimitExceeded = false;
  private _fallbackStartTime: [number, number] | null = null;

  /**
   * Get the elapsed time for a running or completed process.
   * Uses native addons when available for accurate timing, falls back to hrtime.
   */
  private _getElapsedTime(pid: number): number {
    try {
      if (process.platform === "win32") {
        const addon = getWin32TimesAddon();
        if (addon) {
          const times = addon.getWin32ProcessTimes(pid);
          return Math.round(times.elapsedMs);
        }
      } else if (process.platform === "linux") {
        const addon = getLinuxTimesAddon();
        if (addon) {
          const times = addon.getLinuxProcessTimes(pid);
          return Math.round(times.elapsedMs);
        }
      } else if (process.platform === "darwin") {
        const addon = getDarwinTimesAddon();
        if (addon) {
          const times = addon.getDarwinProcessTimes(pid);
          return Math.round(times.elapsedMs);
        }
      }
    } catch (err) {
      // If addon fails (e.g., process already exited), fall back to hrtime
      const logger = getLogger("runtime");
      logger.debug(
        `Native timing addon failed for pid ${pid}, using hrtime fallback: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Fallback to hrtime-based timing
    if (this._fallbackStartTime) {
      const elapsed = process.hrtime(this._fallbackStartTime);
      return Math.round(elapsed[0] * 1000 + elapsed[1] / 1_000_000);
    }
    return 0;
  }

  private async _sampleMemory(pid: number) {
    try {
      if (process.platform === "win32") {
        const addon = getWin32MemoryAddon();
        if (addon) {
          const memStats = addon.getWin32MemoryStats(pid);
          this._maxMemoryBytes = Math.max(this._maxMemoryBytes, memStats.peakRss);
          return;
        } else {
          // fallback to pidusage if addon not available or the addon failed
          // to get the memory stats
        }
      }

      if (process.platform === "linux") {
        const addon = getLinuxMemoryAddon();
        if (addon) {
          const memStats = addon.getLinuxMemoryStats(pid);
          // Prefer kernel high-water mark when available (monotonic).
          this._maxMemoryBytes = Math.max(this._maxMemoryBytes, memStats.peakRss);
          return;
        } else {
          // fallback to pidusage if addon not available or the addon failed
          // to get the memory stats
        }
      }

      const stats = await pidusage(pid);
      this._maxMemoryBytes = Math.max(this._maxMemoryBytes, stats.memory);
    } catch {
      // pidusage can throw if the process exits between samples. Treat as terminal.
      return;
    }
  }

  private async _sampleMemoryRepeatedly(pid: number, token: vscode.CancellationToken) {
    if (token.isCancellationRequested) {
      return;
    }

    await this._sampleMemory(pid);

    if (this._memoryLimitBytes > 0 && this._maxMemoryBytes > this._memoryLimitBytes) {
      this._memoryLimitExceeded = true;
      this._memoryCancellationTokenSource?.cancel();
      const logger = getLogger("runtime");
      logger.debug(
        `Memory limit exceeded, killing process (pid=${pid}, maxMemoryMB=${Math.round(this._maxMemoryBytes / Runnable.BYTES_PER_MEGABYTE)}, limitMB=${Math.round(this._memoryLimitBytes / Runnable.BYTES_PER_MEGABYTE)})`
      );
      this._process?.kill();
      return;
    }

    if (!token.isCancellationRequested) {
      this._memorySampleTimeout = setTimeout(() => {
        void this._sampleMemoryRepeatedly(pid, token);
      }, Runnable.MEMORY_SAMPLE_INTERVAL_MS);
    }
  }

  /**
   * Clean up listeners and ongoing operations without resetting statistics.
   * Called after process completion to prevent listener accumulation on reuse.
   * Preserves elapsed time, memory stats, and exit information.
   */
  cleanup(): void {
    this._memoryCancellationTokenSource?.cancel();
    this._memoryCancellationTokenSource?.dispose();
    this._memoryCancellationTokenSource = null;
    if (this._memorySampleTimeout) {
      clearTimeout(this._memorySampleTimeout);
      this._memorySampleTimeout = null;
    }

    // Remove listeners to prevent accumulation when Runnable is reused
    if (this._process) {
      this._process.removeAllListeners();
      this._process.stdout.removeAllListeners();
      this._process.stderr.removeAllListeners();
    }
  }

  run(command: string[], timeout: number, memoryLimit: number, cwd?: string) {
    if (command.length === 0) {
      throw new Error("Runnable.run requires at least one command element");
    }
    const [commandName, ...commandArgs] = command;
    // Reset metrics for a fresh run. All other state is set by event handlers or reassigned below.
    this.cleanup();
    this._timedOut = false;
    this._maxMemoryBytes = 0;
    this._memoryLimitExceeded = false;
    this._memoryLimitBytes = memoryLimit * Runnable.BYTES_PER_MEGABYTE;
    this._abortController = new AbortController();

    const signals = [this._abortController.signal];
    const timeoutSignal = timeout > 0 ? AbortSignal.timeout(timeout) : null;
    if (timeoutSignal) {
      signals.push(timeoutSignal);
    }
    this._combinedAbortSignal = AbortSignal.any(signals);
    this._process = childProcess.spawn(commandName, commandArgs, {
      cwd,
      signal: this._combinedAbortSignal,
    });
    this._process.stdout.setEncoding("utf-8");
    this._process.stderr.setEncoding("utf-8");

    // Create spawn promise that resolves when process spawns or errors
    let resolveSpawn: (value: boolean) => void;
    this._spawnPromise = new Promise((resolve) => {
      resolveSpawn = resolve;
    });

    this._promise = new Promise((resolve) => {
      this._process?.once("spawn", () => {
        // Keep fallback hrtime for platforms without native addon
        this._fallbackStartTime = process.hrtime();
        this._memoryCancellationTokenSource = new vscode.CancellationTokenSource();
        setTimeout(() => {
          if (this._process?.pid) {
            this._sampleMemoryRepeatedly(
              this._process.pid,
              this._memoryCancellationTokenSource!.token
            );
          }
        });

        resolveSpawn(true);
      });
      this._process?.once("error", (err) => {
        // necessary since an invalid command can lead to process not spawned
        this._fallbackStartTime = process.hrtime();
        const logger = getLogger("runtime");
        logger.error(
          `Process spawn failed (command=${commandName}, args=${commandArgs}, cwd=${cwd ?? "undefined"}, error=${err instanceof Error ? err.message : String(err)})`
        );

        // We have to set error state here because of platform-dependent behavior
        // For Linux exit isn't fired when process errors
        this._elapsed = this._process?.pid ? this._getElapsedTime(this._process.pid) : 0;
        this._signal = null;
        this._exitCode = 1;
        this._timedOut = false;

        resolveSpawn(false);
      });
      this._process?.once("exit", (code, signal) => {
        // Use native addon to get accurate elapsed time, bypassing event loop delays
        this._elapsed = this._process?.pid ? this._getElapsedTime(this._process.pid) : 0;
        this._signal = signal;
        this._exitCode = code;
        this._timedOut = timeoutSignal?.aborted ?? false;
      });

      this._process?.once("close", async () => {
        this._memoryCancellationTokenSource?.cancel();
        this._memoryCancellationTokenSource?.dispose();
        if (this._memorySampleTimeout) {
          clearTimeout(this._memorySampleTimeout);
          this._memorySampleTimeout = null;
        }

        this._memoryLimitExceeded =
          this._maxMemoryBytes > this._memoryLimitBytes && this._memoryLimitBytes > 0;
        resolve();
      });
    });
  }

  get process() {
    return this._process;
  }
  get elapsed(): number {
    return this._elapsed;
  }
  get signal(): NodeJS.Signals | null {
    return this._signal;
  }
  get timedOut(): boolean {
    return this._timedOut;
  }
  get exitCode(): number | null {
    return this._exitCode;
  }
  get maxMemoryBytes(): number {
    return this._maxMemoryBytes;
  }
  get memoryLimitExceeded(): boolean {
    return this._memoryLimitExceeded;
  }
  get spawned(): Promise<boolean> {
    return this._spawnPromise ?? Promise.resolve(false);
  }
  get done(): Thenable<RunTermination> {
    const promise = this._promise ?? Promise.resolve();
    return promise.then(() => this._computeTermination());
  }

  stop() {
    this._abortController?.abort();
  }

  /**
   * Attach a listener to a process event. Returns this for method chaining.
   * Listeners are automatically removed on cleanup() or at the start of the next run().
   */
  on(event: "spawn", listener: () => void): Runnable;
  on(event: "error", listener: (err: Error) => void): Runnable;
  on(event: "stderr:data" | "stdout:data", listener: (data: string) => void): Runnable;
  on(event: "stderr:end" | "stdout:end", listener: () => void): Runnable;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): Runnable;
  on(event: string, listener: ListenerCallback): Runnable {
    this._attachListener(event, listener);
    return this;
  }

  private _attachListener(event: string, listener: ListenerCallback): void {
    const proc = this._process;
    if (!proc) return;

    switch (event) {
      case "spawn":
        proc.once("spawn", listener as () => void);
        break;
      case "error":
        proc.on("error", listener as (err: Error) => void);
        break;
      case "stderr:data":
        proc.stderr.on("data", listener as (data: string) => void);
        break;
      case "stdout:data":
        proc.stdout.on("data", listener as (data: string) => void);
        break;
      case "stderr:end":
        proc.stderr.once("end", listener as () => void);
        break;
      case "stdout:end":
        proc.stdout.once("end", listener as () => void);
        break;
      case "close":
        proc.once(
          "close",
          listener as (code: number | null, signal: NodeJS.Signals | null) => void
        );
        break;
    }
  }

  private _computeTermination(): RunTermination {
    if (this._timedOut) {
      return "timeout";
    }
    if (this._memoryLimitExceeded) {
      return "memory";
    }
    // Check this after timeout because timeout also sets this signal
    if (this._combinedAbortSignal?.aborted) {
      return "stopped";
    }
    if (this._signal) {
      return "signal";
    }
    if (this._exitCode === 0) {
      return "exit";
    }
    return "error";
  }
}

export async function getFileChecksum(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = fs.createReadStream(file, { encoding: "utf8" });
    stream.once("error", (err) => reject(err));
    stream.once("end", () => {
      hash.end();
      resolve(hash.digest("hex"));
    });
    stream.pipe(hash);
  });
}

async function doCompile(
  file: string,
  compileCommand: string[],
  context: vscode.ExtensionContext
): Promise<number> {
  const currentChecksum = await getFileChecksum(file);
  const [cachedChecksum, cachedCommand] = lastCompiled.get(file) ?? [-1, []];
  if (currentChecksum === cachedChecksum && arrayEquals(compileCommand, cachedCommand)) {
    return 0; // avoid unnecessary recompilation
  }

  let promise = compilePromise.get(file);
  if (!promise) {
    promise = (async () => {
      const logger = getLogger("compilation");
      logger.info(`Compilation started: ${file} (${compileCommand})`);

      const compilationStatusItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        10000
      );
      compilationStatusItem.name = "Compilation Status";
      compilationStatusItem.text = `$(zap) ${path.basename(file)}`;
      compilationStatusItem.backgroundColor = new vscode.ThemeColor(
        "statusBarItem.warningBackground"
      );
      compilationStatusItem.show();
      context.subscriptions.push(compilationStatusItem);

      const runnable = new Runnable();
      runnable.run(compileCommand, 0, 0);

      let err = "";
      runnable
        .on("stderr:data", (data) => {
          err += data;
        })
        .on("error", (data) => {
          err += data.stack;
        });

      const termination = await runnable.done;
      runnable.cleanup();
      compilationStatusItem.dispose();

      const status = mapCompilationTermination(termination);
      if (status === "CE" || status === "RE") {
        logger.error(
          `Compilation failed (file=${file}, command=${compileCommand}, exitCode=${runnable.exitCode}, termination=${termination}, stderr=${err.substring(0, 500)})`
        );

        const dummy = new ReadonlyTerminal();
        const terminal = vscode.window.createTerminal({
          name: path.basename(file),
          pty: dummy,
          iconPath: { id: "zap" },
          location: { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        });
        errorTerminal.set(file, terminal);

        terminal.show(true);

        // Ensure the pseudoterminal is opened before writing errors
        await dummy.ready;
        dummy.write(err);
        return runnable.exitCode ?? 1;
      }

      lastCompiled.set(file, [currentChecksum, compileCommand]);
      logger.info(`Compilation succeeded (file=${file})`);
      return 0;
    })();
    compilePromise.set(file, promise);
  }

  const code = await promise;
  compilePromise.delete(file);
  return code;
}

const errorTerminal: Map<string, vscode.Terminal> = new Map();
const lastCompiled: Map<string, [string, string[]]> = new Map(); // [file checksum, compile command]
const compilePromise: Map<string, Promise<number>> = new Map();

export function compile(file: string, context: vscode.ExtensionContext): Promise<number> | null {
  errorTerminal.get(file)?.dispose();

  if (!fs.existsSync(file)) {
    vscode.window.showErrorMessage(`${file} does not exist`);
    return Promise.resolve(1);
  }

  const settings = getFileRunSettings(file);
  if (!settings) {
    vscode.window.showErrorMessage(`No run settings found for ${file}`);
    return Promise.resolve(1);
  }

  const extension = path.extname(file);
  const languageSettings = settings[extension] as LanguageSettings;
  if (!languageSettings.compileCommand) {
    return null;
  }
  return doCompile(file, languageSettings.compileCommand, context);
}

export function clearCompileCache(): void {
  lastCompiled.clear();
}

/**
 * Finds an available TCP port by binding to port 0 and letting the OS assign one.
 * Returns the assigned port number.
 */
export async function findAvailablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Failed to get port")));
      }
    });
    server.on("error", reject);
  });
}
