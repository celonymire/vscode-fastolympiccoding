import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as path from "node:path";
import * as vscode from "vscode";

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

type ProcessHandle = {
  writeStdin(data: string): void;
  endStdin(): void;
  kill(): void;
};

type JudgeAddon = {
  spawnProcess: (
    command: string[],
    cwd: string,
    timeoutMs: number,
    memoryLimitMb: number,
    stdoutCallback: (data: string) => void,
    stderrCallback: (data: string) => void,
    spawnCallback: () => void,
    completionCallback: (
      err: Error | null,
      result?: {
        exitCode: number;
        termSignal: number;
        elapsedMs: number;
        maxMemoryBytes: number;
        timedOut: boolean;
        memoryLimitExceeded: boolean;
        spawnError: boolean;
      }
    ) => void
  ) => ProcessHandle;
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

let judgeAddon: JudgeAddon | null = null;

function getJudgeAddon(): JudgeAddon | null {
  if (judgeAddon !== null) {
    return judgeAddon;
  }

  try {
    const addonPath = path.join(__dirname, "judge.node");
    if (!fs.existsSync(addonPath)) {
      return null;
    }

    const nodeRequire = createRequire(__filename);
    const loaded: unknown = nodeRequire(addonPath);

    if (loaded && typeof loaded === "object" && "spawnProcess" in loaded) {
      judgeAddon = loaded as JudgeAddon;
      return judgeAddon;
    }

    return null;
  } catch (err) {
    const logger = getLogger("runtime");
    logger.error(
      `Judge addon is not available: ${err instanceof Error ? err.message : String(err)}`
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

  private _promise: Promise<void> | undefined = undefined;
  private _elapsed = 0;
  private _signal: NodeJS.Signals | null = null;
  private _timedOut = false;
  private _exitCode: number | null = 0;
  private _maxMemoryBytes = 0;
  private _memoryLimitExceeded = false;

  private _processHandle: ProcessHandle | undefined = undefined;
  private _stdoutListeners: Array<(data: string) => void> = [];
  private _stderrListeners: Array<(data: string) => void> = [];
  private _stdoutEndListeners: Array<() => void> = [];
  private _stderrEndListeners: Array<() => void> = [];
  private _spawnListeners: Array<() => void> = [];
  private _errorListeners: Array<(err: Error) => void> = [];
  private _closeListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];

  /**
   * Clean up listeners and ongoing operations without resetting statistics.
   * Called after process completion to prevent listener accumulation on reuse.
   * Preserves elapsed time, memory stats, and exit information.
   */
  cleanup(): void {
    this._processHandle = undefined;
    this._stdoutListeners = [];
    this._stderrListeners = [];
    this._stdoutEndListeners = [];
    this._stderrEndListeners = [];
    this._spawnListeners = [];
    this._errorListeners = [];
    this._closeListeners = [];
  }

  run(command: string[], timeout: number, memoryLimit: number, cwd?: string) {
    if (command.length === 0) {
      throw new Error("Runnable.run requires at least one command element");
    }

    this._timedOut = false;
    this._maxMemoryBytes = 0;
    this._memoryLimitExceeded = false;

    const addon = getJudgeAddon();
    if (!addon) {
      throw new Error("Judge addon is not available. Cannot spawn process.");
    }

    // Create the promise synchronously so `done` can be awaited immediately after `run()`
    let resolvePromise: () => void;
    this._promise = new Promise((resolve) => {
      resolvePromise = resolve;
    });

    this._runWithAddon(command, timeout, memoryLimit, cwd, addon, resolvePromise!);
  }

  private _runWithAddon(
    command: string[],
    timeout: number,
    memoryLimit: number,
    cwd: string | undefined,
    addon: JudgeAddon,
    resolvePromise: () => void
  ) {
    this._processHandle = addon.spawnProcess(
      command,
      cwd ?? "",
      timeout,
      memoryLimit,
      (data: string) => {
        // Real-time stdout
        this._stdoutListeners.forEach((listener) => listener(data));
      },
      (data: string) => {
        // Real-time stderr
        this._stderrListeners.forEach((listener) => listener(data));
      },
      () => {
        // Spawn callback - fired when process actually spawns on worker thread
        this._spawnListeners.forEach((listener) => listener());
      },
      (err, result) => {
        // Completion callback
        if (err) {
          this._exitCode = 1;
          this._signal = null;
          this._elapsed = 0;
          this._timedOut = false;
          this._errorListeners.forEach((listener) => listener(err));
        } else if (result) {
          this._exitCode = result.exitCode;
          this._signal = result.termSignal ? (`SIG${result.termSignal}` as NodeJS.Signals) : null;
          this._elapsed = result.elapsedMs;
          this._maxMemoryBytes = result.maxMemoryBytes;
          this._timedOut = result.timedOut;
          this._memoryLimitExceeded = result.memoryLimitExceeded;

          // Fire end events before close event
          this._stdoutEndListeners.forEach((listener) => listener());
          this._stderrEndListeners.forEach((listener) => listener());

          this._closeListeners.forEach((listener) => listener(result.exitCode, this._signal));
        }

        resolvePromise();
      }
    );
  }

  /**
   * Get the underlying process handle with stdin access.
   * Returns an object with stdin methods for writing data to the process.
   */
  get process() {
    if (!this._processHandle) {
      return undefined;
    }

    return {
      stdin: {
        write: (data: string) => {
          this._processHandle?.writeStdin(data);
        },
        end: () => {
          this._processHandle?.endStdin();
        },
      },
      kill: () => {
        this._processHandle?.kill();
      },
    };
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
  get done(): Thenable<RunTermination> {
    const promise = this._promise ?? Promise.resolve();
    return promise.then(() => this._computeTermination());
  }

  /**
   * Stop the running process by sending SIGKILL.
   */
  stop() {
    this._processHandle?.kill();
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
    switch (event) {
      case "spawn":
        this._spawnListeners.push(listener as () => void);
        break;
      case "error":
        this._errorListeners.push(listener as (err: Error) => void);
        break;
      case "stderr:data":
        this._stderrListeners.push(listener as (data: string) => void);
        break;
      case "stdout:data":
        this._stdoutListeners.push(listener as (data: string) => void);
        break;
      case "stderr:end":
        this._stderrEndListeners.push(listener as () => void);
        break;
      case "stdout:end":
        this._stdoutEndListeners.push(listener as () => void);
        break;
      case "close":
        this._closeListeners.push(
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
