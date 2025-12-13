import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { ReadonlyTerminal, resolveCommand } from "./vscode";

export class Runnable {
  private _process: childProcess.ChildProcessWithoutNullStreams | undefined = undefined;
  private _promise: Promise<void> | undefined = undefined;
  private _startTime = 0;
  private _endTime = 0;
  private _signal: NodeJS.Signals | null = null;
  private _timedOut = false;
  private _exitCode: number | null = 0;

  run(command: string, timeout?: number, cwd?: string, ...args: string[]) {
    // FIXME: Simplify TL to check a flag once https://github.com/nodejs/node/pull/51608 lands

    const timeoutSignal = timeout ? AbortSignal.timeout(timeout) : undefined;
    this._process = childProcess.spawn(command, args, {
      cwd,
      signal: timeoutSignal,
    });
    this._process.stdout.setEncoding("utf-8");
    this._process.stderr.setEncoding("utf-8");
    this._promise = new Promise((resolve) => {
      this._process?.once("spawn", () => {
        this._startTime = performance.now();
      });
      this._process?.once("error", () => {
        this._startTime = performance.now(); // necessary since an invalid command can lead to process not spawned
      });
      this._process?.once("close", (code, signal) => {
        this._endTime = performance.now();
        this._signal = signal;
        this._exitCode = code;
        this._timedOut = timeoutSignal?.aborted ?? false;
        resolve();
      });
    });
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
      process.run(resolvedArgs[0], undefined, undefined, ...resolvedArgs.slice(1));

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
        return 0;
      }

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
