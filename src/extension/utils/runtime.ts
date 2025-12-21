import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as path from "node:path";
import * as vscode from "vscode";

import pidusage from "pidusage";

import { ReadonlyTerminal, resolveCommand } from "./vscode";
import { getLogger } from "./logging";

type Win32MemoryAddon = {
  getWin32MemoryStats: (pid: number) => { rss: number; peakRss: number };
};

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
    logger.warn("Windows memory addon unavailable, using pidusage fallback (performance degraded)", err);
    return null;
  }
}

export class Runnable {
  // Use a short interval to get more accurate peak memory usage.
  // pidusage uses /proc on Linux which is very cheap to read, Windows uses a native addon,
  // TODO: Test on MacOS and see if we need a native addon there as well.
  private static readonly MEMORY_SAMPLE_INTERVAL_MS = 100;

  private static readonly BYTES_PER_MEGABYTE = 1024 * 1024;

  private _process: childProcess.ChildProcessWithoutNullStreams | undefined = undefined;
  private _promise: Promise<void> | undefined = undefined;
  private _spawnPromise: Promise<boolean> | undefined = undefined;
  private _startTime = 0;
  private _endTime = 0;
  private _signal: NodeJS.Signals | null = null;
  private _timedOut = false;
  private _exitCode: number | null = 0;
  private _memoryCancellationTokenSource: vscode.CancellationTokenSource | null = null;
  private _maxMemoryBytes = 0;
  private _memoryLimitBytes = 0;
  private _memoryLimitExceeded = false;

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
      logger.debug("Memory limit exceeded, killing process", {
        pid,
        maxMemoryMB: Math.round(this._maxMemoryBytes / Runnable.BYTES_PER_MEGABYTE),
        limitMB: Math.round(this._memoryLimitBytes / Runnable.BYTES_PER_MEGABYTE),
      });
      this._process?.kill();
      return;
    }

    if (!token.isCancellationRequested) {
      setTimeout(() => {
        void this._sampleMemoryRepeatedly(pid, token);
      }, Runnable.MEMORY_SAMPLE_INTERVAL_MS);
    }
  }

  private _reset() {
    this._memoryCancellationTokenSource?.cancel();

    this._process = undefined;
    this._promise = undefined;
    this._spawnPromise = undefined;
    this._startTime = 0;
    this._endTime = 0;
    this._signal = null;
    this._timedOut = false;
    this._exitCode = 0;
    this._memoryCancellationTokenSource = null;
    this._maxMemoryBytes = 0;
    this._memoryLimitBytes = 0;
    this._memoryLimitExceeded = false;
  }

  run(command: string, timeout?: number, memoryLimit?: number, cwd?: string, ...args: string[]) {
    // FIXME: Simplify TL to check a flag once https://github.com/nodejs/node/pull/51608 lands

    this._reset();

    // Memory limit is specified in megabytes (0 = no limit).
    this._memoryLimitBytes =
      memoryLimit && memoryLimit > 0 ? memoryLimit * Runnable.BYTES_PER_MEGABYTE : 0;

    const timeoutSignal = timeout ? AbortSignal.timeout(timeout) : undefined;
    this._process = childProcess.spawn(command, args, {
      cwd,
      signal: timeoutSignal,
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
        this._startTime = performance.now();
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
        this._startTime = performance.now(); // necessary since an invalid command can lead to process not spawned
        const logger = getLogger("runtime");
        logger.error("Process spawn failed", {
          command,
          args,
          cwd,
          error: err,
        });
        resolveSpawn(false);
      });
      this._process?.once("close", async (code, signal) => {
        this._memoryCancellationTokenSource?.cancel();

        this._endTime = performance.now();
        this._signal = signal;
        this._exitCode = code;
        this._timedOut = timeoutSignal?.aborted ?? false;
        this._memoryLimitExceeded =
          this._maxMemoryBytes > this._memoryLimitBytes && this._memoryLimitBytes > 0;
        resolve();
      });
    });
  }

  /**
   * Wait for the process to spawn. Returns a promise that resolves to true if the process
   * spawned successfully, or false if there was an error or the process wasn't started.
   */
  async waitForSpawn(): Promise<boolean> {
    return this._spawnPromise ?? Promise.resolve(false);
  }

  get process() {
    return this._process;
  }
  get promise() {
    return this._promise;
  }
  get elapsed(): number {
    return Math.round(this._endTime - this._startTime);
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

const errorTerminal: Map<string, vscode.Terminal> = new Map();
const lastCompiled: Map<string, [string, string]> = new Map(); // [file checksum, compile command]
const compilePromise: Map<string, Promise<number>> = new Map();
export async function compile(
  file: string,
  compileCommand: string,
  context: vscode.ExtensionContext
): Promise<number> {
  errorTerminal.get(file)?.dispose();

  if (!fs.existsSync(file)) {
    vscode.window.showErrorMessage(`${file} does not exist`);
    return 1;
  }

  const resolvedArgs = resolveCommand(compileCommand, file);
  const currentCommand = resolvedArgs.join(" ");
  const currentChecksum = await getFileChecksum(file);
  const [cachedChecksum, cachedCommand] = lastCompiled.get(file) ?? [-1, ""];
  if (currentChecksum === cachedChecksum && currentCommand === cachedCommand) {
    return 0; // avoid unnecessary recompilation
  }

  let promise = compilePromise.get(file);
  if (!promise) {
    promise = (async () => {
      const logger = getLogger("compilation");
      logger.info(`Compilation started: ${file} (${currentCommand})`);

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

      const process = new Runnable();
      process.run(resolvedArgs[0], undefined, undefined, undefined, ...resolvedArgs.slice(1));

      let err = "";
      process.process?.stderr.on("data", (data: string) => {
        err += data;
      });
      process.process?.once("error", (data) => {
        err += data.stack;
      });

      await process.promise;
      compilationStatusItem.dispose();
      if (!process.exitCode) {
        lastCompiled.set(file, [currentChecksum, currentCommand]);
        logger.info("Compilation succeeded", { file });
        return 0;
      }

      logger.error("Compilation failed", {
        file,
        command: currentCommand,
        exitCode: process.exitCode,
        signal: process.signal,
        stderr: err.substring(0, 500), // Truncate for readability
      });

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
      return process.exitCode;
    })();
    compilePromise.set(file, promise);
  }

  const code = await promise;
  compilePromise.delete(file);
  return code;
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
