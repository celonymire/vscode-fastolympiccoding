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
      getLogger("runtime").error(`Process monitor addon not found at ${addonPath}`);
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

export class Runnable extends EventEmitter {
  public pid: number | undefined;
  public stdin: net.Socket | undefined;
  public stdout: net.Socket | undefined;
  public stderr: net.Socket | undefined;

  private _promise: Promise<void> | undefined = undefined;
  private _spawnPromise: Promise<boolean> | undefined = undefined;
  private _elapsed = 0;
  private _timedOut = false;
  private _exitCode: number | null = null;
  private _maxMemoryBytes = 0;
  private _memoryLimitExceeded = false;
  private _stopped = false;
  private _cancel: (() => void) | undefined;

  private _pipeServers: [net.Server, net.Server, net.Server] | null = null;
  private _pipePaths: [string, string, string] | null = null;

  constructor() {
    super();
  }

  private async _disposePipes(): Promise<void> {
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

  async dispose(): Promise<void> {
    this._cleanup();
    await this._disposePipes();
  }

  private _cleanup(): void {
    this.removeAllListeners();
    this.stdin?.removeAllListeners();
    this.stdout?.removeAllListeners();
    this.stderr?.removeAllListeners();
  }

  handleAddonResult(result: AddonResult): void {
    this._elapsed = result.elapsedMs;
    this._maxMemoryBytes = result.peakMemoryBytes;
    this._timedOut = result.timedOut;
    this._memoryLimitExceeded = result.memoryLimitExceeded;
    this._stopped = result.stopped;
    this._exitCode = result.exitCode;
  }

  run(command: string[], timeout: number, memoryLimit: number, cwd?: string) {
    if (command.length === 0) {
      throw new Error("Runnable.run requires at least one command element");
    }

    const [commandName, ...commandArgs] = command;

    this._elapsed = 0;
    this._exitCode = null;
    this._timedOut = false;
    this._maxMemoryBytes = 0;
    this._memoryLimitExceeded = false;
    this._stopped = false;
    this.pid = undefined;
    this.stdin = undefined;
    this.stdout = undefined;
    this.stderr = undefined;
    this._cancel = undefined;

    let resolveSpawn: (value: boolean) => void;
    this._spawnPromise = new Promise((resolve) => {
      resolveSpawn = resolve;
    });

    this._promise = new Promise((resolve) => {
      void (async () => {
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

            const waitForConnection = (server: net.Server): Promise<net.Socket> => {
              return new Promise<net.Socket>((resolve, reject) => {
                const cleanup = () => {
                  server.off("connection", onConn);
                  server.off("error", onError);
                };
                const onConn = (s: net.Socket) => {
                  cleanup();
                  s.setNoDelay(true);
                  resolve(s);
                };
                const onError = (err: Error) => {
                  cleanup();
                  reject(err);
                };
                server.once("connection", onConn);
                server.once("error", onError);
              });
            };

            const pIn = waitForConnection(serverIn);
            const pOut = waitForConnection(serverOut);
            const pErr = waitForConnection(serverErr);

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

            const [socketIn, socketOut, socketErr] = await Promise.all([pIn, pOut, pErr]);

            this.pid = spawnResult.pid;
            this.stdin = socketIn;
            this.stdout = socketOut;
            this.stderr = socketErr;
            this._cancel = spawnResult.cancel;

            this.stdout.setEncoding("utf-8");
            this.stderr.setEncoding("utf-8");

            // Proxy events
            this.stdout.on("data", (data) => this.emit("stdout:data", data));
            this.stderr.on("data", (data) => this.emit("stderr:data", data));
            this.stdout.once("end", () => this.emit("stdout:end"));
            this.stderr.once("end", () => this.emit("stderr:end"));

            resolveSpawn(true);
            this.emit("spawn");

            // Attach stream handlers
            if (this.stdout) {
              this.stdout.resume();
              const p = new Promise<void>((resolve) => {
                if (this.stdout?.destroyed) resolve();
                else this.stdout?.once("close", resolve);
              });
              streamClosePromises.push(p);
            }
            if (this.stderr) {
              this.stderr.resume();
              const p = new Promise<void>((resolve) => {
                if (this.stderr?.destroyed) resolve();
                else this.stderr?.once("close", resolve);
              });
              streamClosePromises.push(p);
            }

            Promise.all([spawnResult.result, ...streamClosePromises])
              .then(([res]): void => {
                this.handleAddonResult(res);
                this.emit("exit", this._exitCode, null);
                this.emit("close", this._exitCode, null);
                this._cleanup();
                resolve();
              })
              .catch((err: Error) => {
                this.emit("error", err);
                this.emit("close", this._exitCode, null);
                this._cleanup();
                resolve();
              });
          } catch (e) {
            this.emit("error", new Error(`${e}`));
            this.emit("close", this._exitCode, null);
            this._cleanup();
            resolveSpawn(false);
            resolve();
          }
        } else {
          this.emit("error", new Error("Native addon not found"));
          this.emit("close", this._exitCode, null);
          this._cleanup();
          resolveSpawn(false);
          resolve();
        }
      })();
    });
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
    this._cancel?.();
    this._stopped = true;
  }

  kill(signal: NodeJS.Signals = "SIGTERM") {
    if (this.pid) {
      try {
        process.kill(this.pid, signal);
      } catch {
        // Ignore ESRCH
      }
    }
  }

  // Override emit to satisfy EventEmitter and our strict typing if needed
  // emit(event: string | symbol, ...args: any[]): boolean {
  //   return super.emit(event, ...args);
  // }

  on(event: "spawn", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  on(event: "stderr:data" | "stdout:data", listener: (data: string) => void): this;
  on(event: "stderr:end" | "stdout:end", listener: () => void): this;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: string, listener: ListenerCallback): this {
    super.on(event, listener);
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
  const content = await fs.promises.readFile(file);
  return crypto.createHash("md5").update(content).digest("hex");
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

      let out = "";
      let err = "";
      runnable
        .on("stderr:data", (data) => {
          err += data;
        })
        .on("stdout:data", (data) => {
          out += data;
        })
        .on("error", (data) => {
          err += data.stack;
        });

      const termination = await runnable.done;
      // runnable.cleanup(); // Handled internally
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

        const OSC_PROMPT = "\x1b]133;A\x07";
        const OSC_COMMAND = "\x1b]133;B\x07";
        const OSC_EXECUTED = "\x1b]133;C\x07";
        const OSC_FINISHED = "\x1b]133;D";

        dummy.write(`${OSC_PROMPT}${OSC_COMMAND}Compilation stdout${OSC_EXECUTED}\n`);
        dummy.write(out);
        dummy.write(`${OSC_FINISHED};0\x07\n`);

        dummy.write(`${OSC_PROMPT}${OSC_COMMAND}Compilation stderr${OSC_EXECUTED}\n`);
        dummy.write(err);
        dummy.write(`${OSC_FINISHED};${runnable.exitCode ?? 1}\x07\n`);

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

  const settings = getFileRunSettings(file);
  if (!settings) {
    return null;
  }

  const extension = path.extname(file);
  const languageSettings = settings[extension] as LanguageSettings;
  if (!languageSettings.compileCommand) {
    return Promise.resolve(0);
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
