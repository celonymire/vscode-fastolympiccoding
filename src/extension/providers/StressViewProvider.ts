import * as vscode from "vscode";
import * as v from "valibot";
import * as crypto from "crypto";

import { StatusSchema, type Status } from "../../shared/enums";
import BaseViewProvider from "./BaseViewProvider";
import {
  compile,
  mapTestcaseTermination,
  Runnable,
  terminationSeverityNumber,
  type Severity,
} from "../utils/runtime";
import {
  getFileRunSettings,
  openInNewEditor,
  showOpenRunSettingsErrorWindow,
  TextHandler,
  type FileRunSettings,
  type WriteMode,
} from "../utils/vscode";
import { getLogger } from "../utils/logging";
import type JudgeViewProvider from "./JudgeViewProvider";
import {
  AddMessageSchema,
  ProviderMessageSchema,
  SaveMessageSchema,
  StateIdValue,
  ViewMessageSchema,
  type StateId,
  type WebviewMessage,
} from "../../shared/stress-messages";

const StressDataSchema = v.object({
  stdin: v.fallback(v.string(), ""),
  stdout: v.fallback(v.string(), ""),
  stderr: v.fallback(v.string(), ""),
  status: v.fallback(StatusSchema, "NA"),
  state: v.picklist(StateIdValue),
});

const FileDataSchema = v.object({
  interactiveMode: v.fallback(v.boolean(), false),
  states: v.fallback(v.array(StressDataSchema), []),
});

type FileData = v.InferOutput<typeof FileDataSchema>;

type State = {
  state: StateId;
  stdin: TextHandler;
  stdout: TextHandler;
  stderr: TextHandler;
  status: Status;
  process: Runnable;
  errorHandler: (err: Error) => void;
  stdoutDataHandler: (data: string) => void;
  stdoutEndHandler: () => void;
  stderrDataHandler: (data: string) => void;
  stderrEndHandler: () => void;
  closeHandler: (code: number | null) => void;
};

interface StressContext {
  state: State[];
  stopFlag: boolean;
  clearFlag: boolean;
  running: boolean;
  interactiveMode: boolean;
  interactiveSecretPromise: Promise<void> | null;
  interactorSecretResolver?: () => void;
  donePromise: Promise<void> | null;
}

export default class extends BaseViewProvider<typeof ProviderMessageSchema, WebviewMessage> {
  private _contexts: Map<string, StressContext> = new Map();
  private _onDidChangeBackgroundTasks = new vscode.EventEmitter<void>();
  readonly onDidChangeBackgroundTasks = this._onDidChangeBackgroundTasks.event;

  private get _currentContext(): StressContext | undefined {
    return this._currentFile ? this._contexts.get(this._currentFile) : undefined;
  }

  // Used by PanelViewProvider
  getRunningStressSessions(): string[] {
    const running: string[] = [];
    for (const [file, ctx] of this._contexts) {
      if (ctx.running) {
        running.push(file);
      }
    }
    return running;
  }

  stopStressSession(file: string) {
    const ctx = this._contexts.get(file);
    if (ctx && ctx.running) {
      ctx.stopFlag = true;
      for (const state of ctx.state) {
        state.process.stop();
      }
    }
  }

  onMessage(msg: v.InferOutput<typeof ProviderMessageSchema>): void {
    switch (msg.type) {
      case "LOADED":
        this.loadCurrentFileData();
        break;
      case "RUN":
        void this.run();
        break;
      case "STOP":
        this.stop();
        break;
      case "VIEW":
        this._view(msg);
        break;
      case "ADD":
        this._add(msg);
        break;
      case "CLEAR":
        this.clear();
        break;
      case "SAVE":
        this._save(msg);
    }
  }

  override onDispose() {
    if (this._currentFile) {
      this._saveState(this._currentFile);
    }
    this.stopAll();

    this._onDidChangeBackgroundTasks.dispose();
    for (const ctx of this._contexts.values()) {
      for (const state of ctx.state) {
        state.process.stop();
        state.process.dispose();
      }
    }
    super.onDispose();
  }

  onShow() {
    this._ensureActiveEditorListener();
    this._syncOrSwitchToTargetFile();
  }

  constructor(
    context: vscode.ExtensionContext,
    private _testcaseViewProvider: JudgeViewProvider
  ) {
    super("stress", context, ProviderMessageSchema);
    this.onShow();
  }

  protected override _sendShowMessage(visible: boolean): void {
    super._postMessage({ type: "SHOW", visible });
  }

  protected override _switchToNoFile() {
    this._currentFile = undefined;
    this._sendShowMessage(false);
    this._onDidChangeBackgroundTasks.fire();
  }

  protected override _switchToFile(file: string) {
    this._currentFile = file;
    this._sendShowMessage(true);

    if (!this._contexts.has(file)) {
      // Load persisted state from workspaceState.
      const fileData = super.readStorage()[file];
      const persistedState = v.parse(FileDataSchema, fileData ?? {});

      this._contexts.set(file, this._createContext(file, persistedState));
    }

    // Send full state to webview.
    this._rehydrateWebviewFromState();
    this._onDidChangeBackgroundTasks.fire();
  }

  private _createContext(file: string, persistedState: FileData): StressContext {
    const states: State[] = [
      this._createState(file, "Generator"),
      this._createState(file, "Solution"),
      this._createState(file, "Judge"),
    ];

    // Restore state values
    for (const fileState of persistedState.states) {
      const state = states.find((s) => s.state === fileState.state);
      if (!state) continue;
      state.status = fileState.status;
      state.stdin.write(fileState.stdin, "force");
      state.stdout.write(fileState.stdout, "force");
      state.stderr.write(fileState.stderr, "force");
    }

    return {
      state: states,
      stopFlag: false,
      clearFlag: false,
      running: false,
      interactiveMode: persistedState.interactiveMode,
      interactiveSecretPromise: null,
      donePromise: null,
    };
  }

  private _createState(file: string, id: StateId): State {
    const state: State = {
      state: id,
      stdin: new TextHandler(),
      stdout: new TextHandler(),
      stderr: new TextHandler(),
      status: "NA",
      process: new Runnable(),
      errorHandler: (err) => this._onProcessError(file, id, err),
      stdoutDataHandler: (data) => this._onStdoutData(file, id, data),
      stdoutEndHandler: () => this._onStdoutEnd(file, id),
      stderrDataHandler: (data) => this._onStderrData(file, id, data),
      stderrEndHandler: () => this._onStderrEnd(),
      closeHandler: (code) => this._onProcessClose(file, id, code),
    };

    // Set up callbacks to send STDIO messages to webview if this is current file
    const updateWebview = (stdio: "STDIN" | "STDOUT" | "STDERR", data: string) => {
      if (this._currentFile === file) {
        super._postMessage({
          type: "STDIO",
          id,
          stdio,
          data,
        });
      }
    };

    state.stdin.callback = (data) => updateWebview("STDIN", data);
    state.stdout.callback = (data) => updateWebview("STDOUT", data);
    state.stderr.callback = (data) => updateWebview("STDERR", data);

    return state;
  }

  protected override _rehydrateWebviewFromState() {
    const ctx = this._currentContext;
    if (!ctx) return;

    super._postMessage({ type: "INIT", interactiveMode: ctx.interactiveMode });
    super._postMessage({ type: "CLEAR" }); // Reset view

    for (const state of ctx.state) {
      super._postMessage({
        type: "STATUS",
        id: state.state,
        status: state.status,
      });
      super._postMessage({
        type: "STDIO",
        id: state.state,
        stdio: "STDIN",
        data: state.stdin.data,
      });
      super._postMessage({
        type: "STDIO",
        id: state.state,
        stdio: "STDOUT",
        data: state.stdout.data,
      });
      super._postMessage({
        type: "STDIO",
        id: state.state,
        stdio: "STDERR",
        data: state.stderr.data,
      });
    }
  }

  async run(): Promise<void> {
    const ctx = this._currentContext;
    if (!ctx) return;

    const donePromise = ctx.donePromise;
    if (donePromise) {
      await donePromise;
      return;
    }

    if (!this._currentFile) {
      return;
    }

    const currentFile = this._currentFile;
    ctx.donePromise = new Promise<void>((resolve) => {
      void (async () => {
        await this._doRun(currentFile);
        resolve();
      })();
    });

    this._onDidChangeBackgroundTasks.fire();
    await ctx.donePromise;
    ctx.donePromise = null;
    this._onDidChangeBackgroundTasks.fire();
  }

  stop() {
    if (this._currentFile) {
      this.stopStressSession(this._currentFile);
    }
  }

  stopAll() {
    for (const file of this._contexts.keys()) {
      this.stopStressSession(file);
    }
  }

  private async _doRun(file: string) {
    const ctx = this._contexts.get(file);
    if (!ctx) return;

    const config = vscode.workspace.getConfiguration("fastolympiccoding");
    const delayBetweenTestcases = config.get<number>("delayBetweenTestcases")!;
    const testcaseTimeLimit = config.get<number>("stressTestcaseTimeLimit")!;
    const testcaseMemoryLimit = config.get<number>("stressTestcaseMemoryLimit")!;
    const timeLimit = config.get<number>("stressTimeLimit")!;

    const solutionSettings = getFileRunSettings(file);
    if (!solutionSettings) {
      return;
    }

    const generatorSettings = getFileRunSettings(solutionSettings.generatorFile!);

    let judgeSettings: FileRunSettings | null;
    if (ctx.interactiveMode) {
      judgeSettings = getFileRunSettings(solutionSettings.interactorFile!);
    } else {
      judgeSettings = getFileRunSettings(solutionSettings.goodSolutionFile!);
    }

    if (!generatorSettings || !judgeSettings) {
      return;
    }

    const logError = (msg: string) => {
      const logger = getLogger("stress");
      logger.error(msg);
      showOpenRunSettingsErrorWindow(msg);
    };

    if (!solutionSettings.languageSettings.runCommand) {
      logError(`No run command for ${file}`);
      return;
    }
    if (!generatorSettings.languageSettings.runCommand) {
      logError(`No run command for ${solutionSettings.generatorFile}`);
      return;
    }
    if (!judgeSettings.languageSettings.runCommand) {
      const judgeFile = ctx.interactiveMode
        ? solutionSettings.interactorFile!
        : solutionSettings.goodSolutionFile!;
      logError(`No run command for ${judgeFile}`);
      return;
    }

    const callback = (state: State, code: number) => {
      const status = code ? "CE" : "NA";
      state.status = status;
      if (this._currentFile === file) {
        super._postMessage({ type: "STATUS", id: state.state, status });
      }
      return code;
    };

    const compilePromises: Promise<number>[] = [];
    const addCompilePromise = (state: State, filePath: string) => {
      const compilePromise = compile(filePath, this._context);
      if (compilePromise) {
        if (this._currentFile === file) {
          super._postMessage({
            type: "STATUS",
            id: state.state,
            status: "COMPILING",
          });
        }
        compilePromises.push(compilePromise.then(callback.bind(this, state)));
      }
    };

    const generatorState = ctx.state.find((s) => s.state === "Generator")!;
    const solutionState = ctx.state.find((s) => s.state === "Solution")!;
    const judgeState = ctx.state.find((s) => s.state === "Judge")!;

    addCompilePromise(generatorState, solutionSettings.generatorFile!);
    addCompilePromise(solutionState, file);
    if (ctx.interactiveMode) {
      addCompilePromise(judgeState, solutionSettings.interactorFile!);
    } else {
      addCompilePromise(judgeState, solutionSettings.goodSolutionFile!);
    }

    const compileCodes = await Promise.all(compilePromises);
    if (compileCodes.some((code) => code !== 0)) {
      this._saveState(file);
      return;
    }

    if (this._currentFile === file) {
      for (const id of StateIdValue) {
        super._postMessage({
          type: "STATUS",
          id,
          status: "RUNNING",
        });
      }
    }

    ctx.stopFlag = false;
    ctx.clearFlag = false;
    ctx.running = true;
    this._onDidChangeBackgroundTasks.fire();

    const start = Date.now();
    while (!ctx.stopFlag && (timeLimit === 0 || Date.now() - start <= timeLimit)) {
      if (this._currentFile === file) {
        super._postMessage({ type: "CLEAR" });
      }
      for (const state of ctx.state) {
        state.stdin.reset();
        state.stdout.reset();
        state.stderr.reset();

        if (this._currentFile === file) {
          super._postMessage({
            type: "STATUS",
            id: state.state,
            status: "RUNNING",
          });
        }
      }
      const seed = crypto.randomBytes(8).readBigUInt64BE();
      ctx.interactiveSecretPromise = new Promise<void>((resolve) => {
        ctx.interactorSecretResolver = resolve;
      });

      const setupProcess = (state: State) => {
        state.process
          .on("error", state.errorHandler)
          .on("stdout:data", state.stdoutDataHandler)
          .on("stdout:end", state.stdoutEndHandler)
          .on("stderr:data", state.stderrDataHandler)
          .on("stderr:end", state.stderrEndHandler)
          .on("close", state.closeHandler);
      };

      setupProcess(judgeState);
      judgeState.process.run(
        judgeSettings.languageSettings.runCommand,
        testcaseTimeLimit,
        testcaseMemoryLimit,
        solutionSettings.languageSettings.currentWorkingDirectory
      );

      setupProcess(generatorState);
      generatorState.process.on("spawn", () => {
        generatorState.process.stdin?.write(`${seed}\n`);
      });
      generatorState.process.run(
        generatorSettings.languageSettings.runCommand,
        0,
        0,
        solutionSettings.languageSettings.currentWorkingDirectory
      );

      setupProcess(solutionState);
      solutionState.process.run(
        solutionSettings.languageSettings.runCommand,
        testcaseTimeLimit,
        testcaseMemoryLimit,
        solutionSettings.languageSettings.currentWorkingDirectory
      );

      const executionPromise = (state: State) => {
        return new Promise<number>((resolve) => {
          void (async () => {
            const termination = await state.process.done;
            state.status = mapTestcaseTermination(termination);
            if (this._currentFile === file) {
              super._postMessage({
                type: "STATUS",
                id: state.state,
                status: state.status,
              });
            }
            resolve(terminationSeverityNumber(termination));
          })();
        });
      };

      const generatorPromise = executionPromise(generatorState);
      const solutionPromise = executionPromise(solutionState);
      const judgePromise = executionPromise(judgeState);

      const severities = await Promise.all([generatorPromise, solutionPromise, judgePromise]);
      const maxSeverity = Math.max(...severities) as Severity;

      if (ctx.interactiveMode) {
        if (maxSeverity === 0) {
          // All finished successfully
          solutionState.status = "AC";
          if (this._currentFile === file) {
            super._postMessage({
              type: "STATUS",
              id: solutionState.state,
              status: solutionState.status,
            });
          }
        } else if (maxSeverity === 1) {
          // Stopped
          break;
        } else if (
          solutionState.process.exitCode === null ||
          judgeState.process.exitCode === null
        ) {
          // Crashed
          break;
        } else if (judgeState.process.exitCode !== 0) {
          // WA
          judgeState.status = "NA";
          solutionState.status = "WA";
          if (this._currentFile === file) {
            super._postMessage({
              type: "STATUS",
              id: judgeState.state,
              status: judgeState.status,
            });
            super._postMessage({
              type: "STATUS",
              id: solutionState.state,
              status: solutionState.status,
            });
          }
          break;
        }
      } else {
        if (maxSeverity > 0) {
          break;
        } else if (solutionState.stdout.data !== judgeState.stdout.data) {
          solutionState.status = "WA";
          if (this._currentFile === file) {
            super._postMessage({
              type: "STATUS",
              id: solutionState.state,
              status: solutionState.status,
            });
          }
          break;
        } else {
          solutionState.status = "AC";
          if (this._currentFile === file) {
            super._postMessage({
              type: "STATUS",
              id: solutionState.state,
              status: solutionState.status,
            });
          }
        }
      }

      await new Promise<void>((resolve) => setTimeout(() => resolve(), delayBetweenTestcases));
    }

    ctx.running = false;

    if (ctx.clearFlag) {
      for (const state of ctx.state) {
        state.stdin.reset();
        state.stdout.reset();
        state.stderr.reset();
        state.status = "NA";
      }

      if (this._currentFile === file) {
        super._postMessage({ type: "CLEAR" });
      }
    }
    ctx.clearFlag = false;

    this._saveState(file);
    this._onDidChangeBackgroundTasks.fire();
  }

  private _view({ id, stdio }: v.InferOutput<typeof ViewMessageSchema>) {
    const ctx = this._currentContext;
    if (!ctx) return;
    const state = ctx.state.find((s) => s.state === id);

    if (!state) {
      return;
    }
    switch (stdio) {
      case "STDIN":
        void openInNewEditor(state.stdin.data);
        break;
      case "STDOUT":
        void openInNewEditor(state.stdout.data);
        break;
      case "STDERR":
        void openInNewEditor(state.stderr.data);
        break;
    }
  }

  private _add({ id }: v.InferOutput<typeof AddMessageSchema>) {
    if (!this._currentFile) {
      return;
    }

    const ctx = this._currentContext;
    if (!ctx) return;

    const settings = getFileRunSettings(this._currentFile);
    if (!settings) {
      return;
    }

    let resolvedFile: string | undefined;
    if (id === "Generator") {
      resolvedFile = settings.generatorFile;
    } else if (id === "Solution") {
      resolvedFile = this._currentFile;
    } else if (id === "Judge") {
      resolvedFile = ctx.interactiveMode ? settings.interactorFile : settings.goodSolutionFile;
    }
    if (!resolvedFile) {
      return;
    }

    const generatorState = ctx.state.find((s) => s.state === "Generator")!;
    const solutionState = ctx.state.find((s) => s.state === "Solution")!;
    const judgeState = ctx.state.find((s) => s.state === "Judge")!;

    if (ctx.interactiveMode) {
      const currentState = ctx.state.find((s) => s.state === id);

      if (currentState?.state === "Solution") {
        this._testcaseViewProvider.addTestcaseToFile(resolvedFile, {
          uuid: crypto.randomUUID(),
          stdin: judgeState.stdout.data, // Interactor output is stdin for solution
          stderr: solutionState.stderr.data + judgeState.stderr.data,
          stdout: solutionState.stdout.data,
          acceptedStdout: "",
          elapsed: currentState?.process.elapsed ?? 0,
          memoryBytes: currentState?.process.maxMemoryBytes ?? 0,
          status: currentState?.status ?? "NA",
          shown: true,
          toggled: false,
          skipped: false,
          mode: "interactive",
          interactorSecret: generatorState.stdout.data,
        });
      } else if (currentState?.state === "Judge") {
        // add as standard testcase easily debug the interactor from reproduced queries
        this._testcaseViewProvider.addTestcaseToFile(resolvedFile, {
          uuid: crypto.randomUUID(),
          stdin: generatorState.stdout.data + solutionState.stdout.data,
          stderr: solutionState.stderr.data + judgeState.stderr.data,
          stdout: judgeState.stdout.data,
          acceptedStdout: "",
          elapsed: currentState?.process.elapsed ?? 0,
          memoryBytes: currentState?.process.maxMemoryBytes ?? 0,
          status: currentState?.status ?? "NA",
          shown: true,
          toggled: false,
          skipped: false,
          mode: "standard",
          interactorSecret: generatorState.stdout.data,
        });
      }
    } else {
      const currentState = ctx.state.find((s) => s.state === id);

      this._testcaseViewProvider.addTestcaseToFile(resolvedFile, {
        uuid: crypto.randomUUID(),
        stdin: generatorState.stdout.data,
        stderr: currentState?.stderr.data ?? "",
        stdout: currentState?.stdout.data ?? "",
        acceptedStdout: judgeState.stdout.data,
        elapsed: currentState?.process.elapsed ?? 0,
        memoryBytes: currentState?.process.maxMemoryBytes ?? 0,
        status: currentState?.status ?? "NA",
        shown: true,
        toggled: false,
        skipped: false,
        mode: "standard",
        interactorSecret: "",
      });
    }
  }

  clear() {
    const ctx = this._currentContext;
    if (!ctx) return;

    if (ctx.running) {
      ctx.clearFlag = true;
      this.stop();
    } else {
      for (const state of ctx.state) {
        state.stdin.reset();
        state.stdout.reset();
        state.stderr.reset();
        state.status = "NA";
      }

      super._postMessage({ type: "CLEAR" });
      if (this._currentFile) {
        void this._saveState(this._currentFile);
      }
    }
  }

  _save({ interactiveMode }: v.InferOutput<typeof SaveMessageSchema>) {
    const ctx = this._currentContext;
    if (!ctx) {
      return;
    }

    ctx.interactiveMode = interactiveMode;
    if (this._currentFile) {
      void this._saveState(this._currentFile);
    }
  }

  private _saveState(file: string) {
    const ctx = this._contexts.get(file);
    if (!ctx) {
      return;
    }

    const defaultData = v.parse(FileDataSchema, {});
    const data: FileData = {
      interactiveMode: ctx.interactiveMode,
      states: [],
    };
    for (const state of ctx.state) {
      data.states.push({
        state: state.state,
        status: state.status,
        stdin: state.stdin.data,
        stdout: state.stdout.data,
        stderr: state.stderr.data,
      });
    }
    void super.writeStorage(
      file,
      JSON.stringify(defaultData) === JSON.stringify(data) ? undefined : data
    );
  }

  private _onProcessError(file: string, stateId: StateId, data: Error) {
    if (data.name !== "AbortError") {
      const logger = getLogger("stress");
      const ctx = this._contexts.get(file);
      const state = ctx?.state.find((s) => s.state === stateId);
      logger.error(`${file} ${stateId} process error: ${data.message}`);
      if (state) {
        state.stderr.write(data.message, "final");
      }
    }

    const ctx = this._contexts.get(file);
    if (ctx) {
      for (const s of ctx.state) {
        s.process.kill();
      }
    }
  }

  private async _onStdoutData(file: string, stateId: StateId, data: string) {
    const ctx = this._contexts.get(file);
    if (!ctx) {
      return;
    }

    const state = ctx.state.find((s) => s.state === stateId);

    const generatorState = ctx.state.find((s) => s.state === "Generator")!;
    const solutionState = ctx.state.find((s) => s.state === "Solution")!;
    const judgeState = ctx.state.find((s) => s.state === "Judge")!;

    if (stateId === "Generator") {
      const writeMode: WriteMode = ctx.interactiveMode ? "force" : "batch";
      generatorState.stdout.write(data, writeMode);

      if (ctx.interactiveMode) {
        // Generator provides the secret for the interactor
        judgeState.process.stdin?.write(data);
      } else {
        // Generator pipes to solution and good solution
        solutionState.process.stdin?.write(data);
        judgeState.process.stdin?.write(data);
      }
    } else if (stateId === "Judge") {
      if (ctx.interactiveMode) {
        solutionState.process.stdin?.write(data);
        state?.stdout.write(data, "force");
      } else {
        state?.stdout.write(data, "batch");
      }
    } else {
      if (ctx.interactiveMode) {
        // Make sure generator sends the secret before sending our queries
        if (ctx.interactiveSecretPromise) {
          await ctx.interactiveSecretPromise;
          ctx.interactiveSecretPromise = null;
        }

        judgeState.process.stdin?.write(data);
        state?.stdout.write(data, "force");
      } else {
        state?.stdout.write(data, "batch");
      }
    }
  }

  private _onStdoutEnd(file: string, stateId: StateId) {
    const ctx = this._contexts.get(file);
    if (!ctx) {
      return;
    }

    if (ctx.interactiveMode && stateId === "Generator") {
      ctx.interactorSecretResolver?.();
      ctx.interactorSecretResolver = undefined;
    }

    const state = ctx.state.find((s) => s.state === stateId);
    state?.stdout.write("", "final");
  }

  private _onProcessClose(file: string, stateId: StateId, code: number | null) {
    const ctx = this._contexts.get(file);
    if (!ctx) {
      return;
    }

    const state = ctx.state.find((s) => s.state === stateId);
    if (!state) {
      return;
    }

    if (code !== 0) {
      for (const sibling of ctx.state) {
        if (sibling.state !== stateId) {
          sibling.process.stop();
        }
      }
    }
  }

  private _onStderrData(file: string, stateId: StateId, data: string) {
    const ctx = this._contexts.get(file);
    if (!ctx) {
      return;
    }

    const state = ctx.state.find((s) => s.state === stateId);
    const writeMode: WriteMode = ctx.interactiveMode ? "force" : "batch";
    state?.stderr.write(data, writeMode);
  }

  private _onStderrEnd() {}

  toggleWebviewSettings() {
    super._postMessage({ type: "SETTINGS_TOGGLE" });
  }
}
