import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import os from "node:os";
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

type AddonResult = {
  elapsedMs: number;
  peakMemoryBytes: number;
  exitCode: number | null;
  timedOut: boolean;
  memoryLimitExceeded: boolean;
  stopped: boolean;
};

type NativeSpawnResult = {
  pid: number;
  stdio: [number, number, number]; // stdin, stdout, stderr FDs
  result: Promise<AddonResult>;
  cancel: () => void;
};

type ProcessMonitorAddon = {
  spawn: (
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number,
    memoryLimitMB: number,
    pipeIn: string,
    pipeOut: string,
    pipeErr: string,
    onSpawn: () => void
  ) => NativeSpawnResult;
};

let processMonitor: ProcessMonitorAddon | null = null;
let processMonitorLoaded = false;

function getNativeProcessMonitor(): ProcessMonitorAddon | null {
  if (processMonitorLoaded) {
    return processMonitor;
  }

  processMonitorLoaded = true;
  let addonPath = "";

  try {
    if (process.platform === "linux") {
      addonPath = path.join(__dirname, "linux-process-monitor.node");
    } else if (process.platform === "darwin") {
      addonPath = path.join(__dirname, "darwin-process-monitor.node");
    } else if (process.platform === "win32") {
      addonPath = path.join(__dirname, "win32-process-monitor.node");
    } else {
      return null;
    }

    if (!fs.existsSync(addonPath)) {
      getLogger("runtime").warn(`Process monitor addon not found at ${addonPath}`);
      return null;
    }

    const nodeRequire = createRequire(__filename);
    const loaded: unknown = nodeRequire(addonPath);

    if (loaded && typeof loaded === "object" && "spawn" in loaded) {
      processMonitor = loaded as ProcessMonitorAddon;
      return processMonitor;
    }

    getLogger("runtime").warn(`Process monitor addon found but invalid signature at ${addonPath}`);
    return null;
  } catch (err) {
    const logger = getLogger("runtime");
    logger.warn(
      `Process monitor addon unavailable (${process.platform}), using fallback: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

// ============================================================================
// RunSession API Types
// ============================================================================

export type RunTermination =
  | "error" // process exited with non-zero code (or early abort with null code)
  | "timeout" // killed by timeout
  | "memory" // killed by memory limit
  | "stopped" // stopped by caller
  | "exit"; // normal exit (zero exit code)

export type Severity = 0 | 1 | 2 | 3 | 4;

export function terminationSeverityNumber(termination: RunTermination): Severity {
  switch (termination) {
    case "exit":
      return 0;
    case "stopped":
      return 1;
    case "error":
      return 2;
    case "memory":
      return 3;
    case "timeout":
      return 4;
  }
}

export function severityNumberToInteractiveStatus(severity: Severity): Status {
  switch (severity) {
    case 0:
      return "AC";
    case 1:
      return "NA";
    case 2:
      return "WA";
    case 3:
      return "ML";
    case 4:
      return "TL";
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
    case "exit":
      return "NA";
    default:
      return "RE";
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

import { EventEmitter } from "node:events";

class NativeChildProcess extends EventEmitter {
  pid: number;
  stdin: net.Socket;
  stdout: net.Socket;
  stderr: net.Socket;
  // The promise that resolves when the process exits
  readonly result: Promise<AddonResult>;
  private _cancel: () => void;

  constructor(
    pid: number,
    io: [net.Socket, net.Socket, net.Socket],
    resultPromise: Promise<AddonResult>,
    cancel: () => void
  ) {
    super();
    this.pid = pid;
    this.result = resultPromise;
    this._cancel = cancel;

    this.stdin = io[0];
    this.stdout = io[1];
    this.stderr = io[2];
    this.stdout.setEncoding("utf-8");
    this.stderr.setEncoding("utf-8");
  }

  stop() {
    this._cancel();
  }

  kill(signal: NodeJS.Signals = "SIGTERM") {
    try {
      process.kill(this.pid, signal);
    } catch {
      // Ignore ESRCH
    }
  }
}

// Basic structural typing to match ChildProcess where we use it
interface ChildProcessLike {
  pid?: number;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: string, listener: ListenerCallback): this;
  once(event: string, listener: ListenerCallback): this;
  off(event: string, listener: ListenerCallback): this;
  removeAllListeners(event?: string): this;
  kill(signal?: NodeJS.Signals): boolean;
  stop(): void;
}

export class Runnable {
  private _process: ChildProcessLike | undefined = undefined;
  private _emitter = new EventEmitter();
  private _promise: Promise<void> | undefined = undefined;
  private _spawnPromise: Promise<boolean> | undefined = undefined;
  private _elapsed = 0;
  private _timedOut = false;
  private _exitCode: number | null = null;
  private _maxMemoryBytes = 0;
  private _memoryLimitExceeded = false;
  private _stopped = false;

  private _pipeServers: [net.Server, net.Server, net.Server] | null = null;
  private _pipePaths: [string, string, string] | null = null;

  async dispose(): Promise<void> {
    this.cleanup();
    if (this._pipeServers) {
      const servers = this._pipeServers;
      this._pipeServers = null;
      this._pipePaths = null;
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((resolve) => {
              s.close(() => resolve());
            })
        )
      );
    }
  }

  cleanup(): void {
    this._emitter.removeAllListeners();
    if (this._process) {
      this._process.removeAllListeners();
      // Use logical check to see if we can remove listeners on streams
      // (NativeChildProcess streams are Node streams so they have removeAllListeners)
      if (typeof this._process.stdout.removeAllListeners === "function") {
        this._process.stdout.removeAllListeners();
      }
      if (typeof this._process.stderr.removeAllListeners === "function") {
        this._process.stderr.removeAllListeners();
      }
    }
  }

  handleAddonResult(result: AddonResult): void {
    this._elapsed = result.elapsedMs;
    this._maxMemoryBytes = result.peakMemoryBytes;
    this._timedOut = result.timedOut;
    this._memoryLimitExceeded = result.memoryLimitExceeded;
    this._stopped = result.stopped;
    this._exitCode = result.exitCode;
  }

  handleMonitorError(error: unknown): void {
    const logger = getLogger("runtime");
    logger.error(
      `Process monitor addon failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  run(command: string[], timeout: number, memoryLimit: number, cwd?: string) {
    if (command.length === 0) {
      throw new Error("Runnable.run requires at least one command element");
    }

    const [commandName, ...commandArgs] = command;

    this.cleanup();
    this._elapsed = 0;
    this._exitCode = null;
    this._timedOut = false;
    this._maxMemoryBytes = 0;
    this._memoryLimitExceeded = false;
    this._stopped = false;

    let resolveSpawn: (value: boolean) => void;
    this._spawnPromise = new Promise((resolve) => {
      resolveSpawn = resolve;
    });

    this._promise = new Promise(async (resolve) => {
      const streamClosePromises: Promise<void>[] = [];
      const monitor = getNativeProcessMonitor();
      if (monitor) {
        try {
          // Initialize pipes if needed
          if (!this._pipeServers) {
            const createPipeServer = (name: string): Promise<net.Server> => {
              return new Promise((resolve, reject) => {
                const server = net.createServer();
                server.listen(name, () => resolve(server));
                server.on("error", reject);
              });
            };

            const id = crypto.randomBytes(8).toString("hex");
            let pipeNameIn: string, pipeNameOut: string, pipeNameErr: string;

            if (process.platform === "win32") {
              pipeNameIn = `\\\\.\\pipe\\foc-${id}-in`;
              pipeNameOut = `\\\\.\\pipe\\foc-${id}-out`;
              pipeNameErr = `\\\\.\\pipe\\foc-${id}-err`;
            } else {
              const tmpDir = os.tmpdir();
              pipeNameIn = path.join(tmpDir, `foc-${id}-in.sock`);
              pipeNameOut = path.join(tmpDir, `foc-${id}-out.sock`);
              pipeNameErr = path.join(tmpDir, `foc-${id}-err.sock`);
            }

            const servers = await Promise.all([
              createPipeServer(pipeNameIn),
              createPipeServer(pipeNameOut),
              createPipeServer(pipeNameErr),
            ]);
            this._pipeServers = servers as [net.Server, net.Server, net.Server];
            this._pipePaths = [pipeNameIn, pipeNameOut, pipeNameErr];
          }

          const [serverIn, serverOut, serverErr] = this._pipeServers!;
          const [pipeNameIn, pipeNameOut, pipeNameErr] = this._pipePaths!;

          let socketIn: net.Socket, socketOut: net.Socket, socketErr: net.Socket;
          let connected = 0;

          const onConnect = () => {
            connected++;
            if (connected === 3) {
              // Create NativeChildProcess
              const nativeProc = new NativeChildProcess(
                spawnResult.pid,
                [socketIn, socketOut, socketErr],
                spawnResult.result,
                spawnResult.cancel
              );
              this._process = nativeProc as unknown as ChildProcessLike;

              // Proxy events from the native process to our internal emitter
              nativeProc.once("spawn", () => this._emitter.emit("spawn"));
              nativeProc.on("error", (err) => this._emitter.emit("error", err));
              nativeProc.stdout.on("data", (data) => this._emitter.emit("stdout:data", data));
              nativeProc.stderr.on("data", (data) => this._emitter.emit("stderr:data", data));
              nativeProc.stdout.once("end", () => this._emitter.emit("stdout:end"));
              nativeProc.stderr.once("end", () => this._emitter.emit("stderr:end"));
              nativeProc.once("close", (code, signal) => this._emitter.emit("close", code, signal));

              // Signal spawn success
              nativeProc.emit("spawn");
              resolveSpawn(true);

              const logger = getLogger("runtime");

              // Attach stream handlers
              if (nativeProc.stdout) {
                nativeProc.stdout.resume();
                const p = new Promise<void>((resolve) => {
                  if (nativeProc.stdout.destroyed) resolve();
                  else nativeProc.stdout.once("close", resolve);
                });
                streamClosePromises.push(p);
              }
              if (nativeProc.stderr) {
                nativeProc.stderr.resume();
                const p = new Promise<void>((resolve) => {
                  if (nativeProc.stderr.destroyed) resolve();
                  else nativeProc.stderr.once("close", resolve);
                });
                streamClosePromises.push(p);
              }

              Promise.all([nativeProc.result, Promise.all(streamClosePromises)])
                .then(([res]): void => {
                  this.handleAddonResult(res);
                  nativeProc.emit("exit", this._exitCode, null);
                  nativeProc.emit("close", this._exitCode, null);
                  resolve();
                })
                .catch((err: Error) => {
                  logger.error("Process error: " + err.message);
                  this.handleMonitorError(err);
                  nativeProc.emit("error", err);
                  resolve();
                });
            }
          };

          serverIn.once("connection", (s) => {
            s.setNoDelay(true);
            socketIn = s;
            onConnect();
          });
          serverOut.once("connection", (s) => {
            s.setNoDelay(true);
            socketOut = s;
            onConnect();
          });
          serverErr.once("connection", (s) => {
            s.setNoDelay(true);
            socketErr = s;
            onConnect();
          });

          // Call native spawn now that listeners are setup
          const spawnResult = monitor.spawn(
            commandName,
            commandArgs,
            cwd || "",
            timeout,
            memoryLimit,
            pipeNameIn,
            pipeNameOut,
            pipeNameErr,
            () => {} // Callback unused in this flow setup
          );
        } catch (e) {
          getLogger("runtime").warn(`Native spawn preparation failed: ${e}`);
          resolveSpawn(false);
          resolve();
        }
      } else {
        // Fallback or Error if monitor not available (but we expect it to be available)
        // Since we don't have a fallback impl in this snippet, we just error.
        getLogger("runtime").error(`Process monitor addon not found. Cannot spawn: ${commandName}`);
        resolveSpawn(false);
        resolve();
      }
    });
  }

  get process() {
    return this._process;
  }

  get elapsed(): number {
    return this._elapsed;
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
    this._process?.stop();
    this._stopped = true;
  }

  on(event: "spawn", listener: () => void): Runnable;
  on(event: "error", listener: (err: Error) => void): Runnable;
  on(event: "stderr:data" | "stdout:data", listener: (data: string) => void): Runnable;
  on(event: "stderr:end" | "stdout:end", listener: () => void): Runnable;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): Runnable;
  on(event: string, listener: ListenerCallback): Runnable {
    this._emitter.on(event, listener);
    return this;
  }

  private _computeTermination(): RunTermination {
    if (this._timedOut) {
      return "timeout";
    }
    if (this._memoryLimitExceeded) {
      return "memory";
    }
    if (this._stopped) {
      return "stopped";
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
        .on("stdout:data", () => {
          // Ignore stdout but listener ensures stream flows (prevents huge stdout blocking process)
        })
        .on("error", (data) => {
          err += data.stack;
        });

      const termination = await runnable.done;
      runnable.cleanup();
      await runnable.dispose();
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
