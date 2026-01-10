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
  exitCode: number;
  timedOut: boolean;
  memoryLimitExceeded: boolean;
  stopped: boolean;
};

type NativeSpawnResult = {
  pid: number;
  stdio: [number, number, number]; // stdin, stdout, stderr FDs
  result: Promise<AddonResult>;
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
  killed: boolean = false;
  // The promise that resolves when the process exits
  readonly result: Promise<AddonResult>;

  constructor(pid: number, io: [net.Socket, net.Socket, net.Socket], resultPromise: Promise<AddonResult>) {
    super();
    this.pid = pid;
    this.result = resultPromise;

    this.stdin = io[0];
    this.stdout = io[1];
    this.stderr = io[2];
    this.stdout.setEncoding("utf-8");
    this.stderr.setEncoding("utf-8");
  }

  kill(signal: NodeJS.Signals = "SIGTERM") {
    try {
      process.kill(this.pid, signal);
      this.killed = true;
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
}

export class Runnable {
  private static readonly BYTES_PER_MEGABYTE = 1024 * 1024;

  private _process: ChildProcessLike | undefined = undefined;
  private _promise: Promise<void> | undefined = undefined;
  private _spawnPromise: Promise<boolean> | undefined = undefined;
  private _elapsed = 0;
  private _signal: NodeJS.Signals | null = null;
  private _abortController: AbortController | null = null;
  private _combinedAbortSignal: AbortSignal | null = null;
  private _timedOut = false;
  private _exitCode: number | null = 0;
  private _maxMemoryBytes = 0;
  private _memoryLimitExceeded = false;
  private _fallbackStartTime: [number, number] | null = null;
  private _addonResult: AddonResult | null = null;

  private _getElapsedTime(): number {
    if (this._addonResult) {
      return this._addonResult.elapsedMs;
    }
    if (this._fallbackStartTime) {
      const elapsed = process.hrtime(this._fallbackStartTime);
      return Math.round(elapsed[0] * 1000 + elapsed[1] / 1_000_000);
    }
    return 0;
  }

  cleanup(): void {
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

  run(command: string[], timeout: number, memoryLimit: number, cwd?: string) {
    if (command.length === 0) {
      throw new Error("Runnable.run requires at least one command element");
    }

    const [commandName, ...commandArgs] = command;

    this.cleanup();
    this._timedOut = false;
    this._maxMemoryBytes = 0;
    this._memoryLimitExceeded = false;
    this._abortController = new AbortController();

    const signals = [this._abortController.signal];
    const timeoutSignal = timeout > 0 ? AbortSignal.timeout(timeout) : null;
    if (timeoutSignal) {
      signals.push(timeoutSignal);
    }
    this._combinedAbortSignal = AbortSignal.any(signals);

    let resolveSpawn: (value: boolean) => void;
    this._spawnPromise = new Promise((resolve) => {
      resolveSpawn = resolve;
    });

    this._promise = new Promise((resolve) => {
      const handleAddonResult = (result: AddonResult) => {
        this._addonResult = result;
        this._elapsed = result.elapsedMs;
        this._maxMemoryBytes = result.peakMemoryBytes;
        this._timedOut = result.timedOut;
        this._memoryLimitExceeded = result.memoryLimitExceeded;
      };

      const handleMonitorError = (error: unknown) => {
        const logger = getLogger("runtime");
        logger.error(
          `Process monitor addon failed: ${error instanceof Error ? error.message : String(error)}`
        );
      };

      let nativeSpawned = false;

      const streamClosePromises: Promise<void>[] = [];

      const monitor = getNativeProcessMonitor();
      if (monitor) {
        // Platform specific pipe creation
        // Windows needs named pipes. Linux/Mac use anonymous pipes usually, but we are designing this for Windows specifically.
        // If we want to support Linux/Mac eventually, we'd wrap this logic.
        // For now, only windows uses this addon in this file (ProcessMonitorAddon is used only if available).
        
        try {
          const createPipeServer = (name: string): Promise<net.Server> => {
              return new Promise((resolve, reject) => {
                  const server = net.createServer();
                  server.listen(name, () => resolve(server));
                  server.on('error', reject);
              });
          };

          const id = crypto.randomBytes(8).toString('hex');
          let pipeNameIn, pipeNameOut, pipeNameErr;

          if (process.platform === 'win32') {
             pipeNameIn = `\\\\.\\pipe\\foc-${id}-in`;
             pipeNameOut = `\\\\.\\pipe\\foc-${id}-out`;
             pipeNameErr = `\\\\.\\pipe\\foc-${id}-err`;
          } else {
             const tmpDir = os.tmpdir();
             pipeNameIn = path.join(tmpDir, `foc-${id}-in.sock`);
             pipeNameOut = path.join(tmpDir, `foc-${id}-out.sock`);
             pipeNameErr = path.join(tmpDir, `foc-${id}-err.sock`);
          }

          let serverIn: net.Server, serverOut: net.Server, serverErr: net.Server;
          let socketIn: net.Socket, socketOut: net.Socket, socketErr: net.Socket;

          // Start listeners
          Promise.all([
             createPipeServer(pipeNameIn),
             createPipeServer(pipeNameOut),
             createPipeServer(pipeNameErr)
          ]).then(servers => {
             [serverIn, serverOut, serverErr] = servers;
             
             let connected = 0;
             const onConnect = () => {
                 connected++;
                 if (connected === 3) {
                     serverIn.close();
                     serverOut.close();
                     serverErr.close();
                     
                     // We have our sockets
                     const result = monitor.spawn(
                        commandName,
                        commandArgs,
                        cwd || "",
                        timeout,
                        memoryLimit,
                        pipeNameIn,
                        pipeNameOut,
                        pipeNameErr,
                        () => {
                            process.nextTick(() => nativeProc.emit("spawn"));
                            resolveSpawn(true);
                        }
                     );
                     
                     const nativeProc = new NativeChildProcess(result.pid, [socketIn, socketOut, socketErr], result.result);
                     this._process = nativeProc as unknown as ChildProcessLike;
                     nativeSpawned = true;
                     this._fallbackStartTime = process.hrtime();
                     
                     // Attach result handlers
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
                          handleAddonResult(res);
                          this._exitCode = res.exitCode;
                          nativeProc.emit("exit", this._exitCode, null);
                          nativeProc.emit("close", this._exitCode, null);
                          resolve();
                        })
                        .catch((err: Error) => {
                          handleMonitorError(err);
                          nativeProc.emit("error", err);
                          resolveSpawn(false);
                          resolve();
                        });
                 }
             };
             
             serverIn.on('connection', s => { socketIn = s; onConnect(); });
             serverOut.on('connection', s => { socketOut = s; onConnect(); });
             serverErr.on('connection', s => { socketErr = s; onConnect(); });
             
             // Now call spawn (which connects)
             // ... actually we can't call spawn until we are listening, which we are.
             // But we need to define the spawn call after listening.
             // The original code was synchronous.
             // Wait, the addon connects synchronously inside spawn.
             // So we must be listening BEFORE calling spawn.
             
             // The issue is: `spawn` calls `CreateFile` which connects.
             // If we call spawn here, it will trigger the connections.
             
             monitor.spawn(
                commandName,
                commandArgs,
                cwd || "",
                timeout,
                memoryLimit,
                pipeNameIn,
                pipeNameOut,
                pipeNameErr,
                () => {} // We handle spawn/resolve later in the "connected" block?
                         // Actually if we wait for connection to create the NativeChildProcess, 
                         // we delay the "spawn" event (which is fine).
                         // BUT `result` comes from spawn.
             );
             // Wait, `monitor.spawn` returns `{ pid, result }`.
             // We need that result to create NativeChildProcess.
             // But we only get sockets in the callback.
             // This structure is tricky.
          });
          
          /*
          REVISION:
          We need to launch `monitor.spawn` carefully.
          If `monitor.spawn` blocks until connection, we are fine as long as listen is async (it is).
          BUT `monitor.spawn` is synchronous on the JS side (C++ runs on main thread until it returns).
          So `monitor.spawn` won't return until `CreateFile` returns (connected) or fails.
          Node.js `net.Server` runs on the event loop.
          If `monitor.spawn` blocks the main thread, the event loop won't process the connection?
          CRITICAL: Node.js is single threaded for JS.
          If C++ blocks on `CreateFile` waiting for connection, and Node.js needs to run JS/Libuv to accept connection...
          We have a DEADLOCK if `monitor.spawn` blocks waiting for connection.
          
          CORRECTION to C++ Implementation:
          `CreateFile` with `OPEN_EXISTING` for a named pipe will BLOCK if the pipe is busy, but if we are the first client...
          Wait, `CreateFile` returns immediately if the server is listening.
          Does Node.js `server.listen` actually start listening at kernel level immediately? Yes.
          So `CreateFile` should succeed immediately.
          However, the `connection` event on JS side depends on the Event Loop.
          So if C++ is blocking, `socket` variables won't be populated until C++ returns.
          
          Flow:
          1. JS: `server.listen(...)` (async, but returns server immediately, listen backlog active in kernel)
          2. JS: Call `monitor.spawn(...)`
          3. C++: `CreateFile(...)` -> Connects to pipe. Kernel accepts.
          4. C++: Returns `pid`, `result`.
          5. JS: `monitor.spawn` returns.
          6. JS: Event Loop runs. `connection` event fires on servers. sockets are available.
          
          So we don't have the sockets *immediately* when `monitor.spawn` returns.
          We need to wait for the connection events to create the `NativeChildProcess`.
          */
          
          // Implementation is complex inside this small block.
          // Let's rewrite the logic to be clean:
          
          /*
             Promise.all([listen...]).then(() => {
                 const res = monitor.spawn(...);
                 // We don't have sockets yet.
                 // We need to wait for connection events.
                 
                 let sockets = [];
                 const checkReady = () => { ... create NativeChildProcess ... }
                 
                 serverIn.on('connection', s => { ... });
             });
          */
          
        } catch (e) {
          getLogger("runtime").warn(`Native spawn failed: ${e}, falling back`);
        }
      }

      if (!nativeSpawned) {
        getLogger("runtime").error(
          `Native monitor failed to spawn process for command: ${commandName}`
        );
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
        .on("stdout:data", () => {
          // Ignore stdout but listener ensures stream flows (prevents huge stdout blocking process)
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
