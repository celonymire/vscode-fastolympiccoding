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

export default class extends BaseViewProvider<typeof ProviderMessageSchema, WebviewMessage> {
  private _state: State[] = [];
  private _stopFlag = false;
  private _clearFlag = false;
  private _running = false;
  private _interactiveMode = false;
  private _interactiveSecretPromise: Promise<void> | null = null;
  private _interactorSecretResolver?: () => void;
  private _donePromise: Promise<void> | null = null;
  private _generatorState: State;
  private _solutionState: State;
  private _judgeState: State;

  private _findState(id: StateId): State | null {
    const index = this._state.findIndex((state) => state.state === id);
    if (index === -1) {
      return null;
    }
    return this._state[index];
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
    this.stop();
    this._judgeState.process.dispose();
    this._solutionState.process.dispose();
    this._generatorState.process.dispose();

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

    // Initialize state with handlers bound to each StateId
    this._state = [
      {
        state: "Generator",
        stdin: new TextHandler(),
        stdout: new TextHandler(),
        stderr: new TextHandler(),
        status: "NA",
        process: new Runnable(),
        errorHandler: this._onProcessError.bind(this, "Generator"),
        stdoutDataHandler: this._onStdoutData.bind(this, "Generator"),
        stdoutEndHandler: this._onStdoutEnd.bind(this, "Generator"),
        stderrDataHandler: this._onStderrData.bind(this, "Generator"),
        stderrEndHandler: this._onStderrEnd.bind(this, "Generator"),
        closeHandler: this._onProcessClose.bind(this, "Generator"),
      },
      {
        state: "Solution",
        stdin: new TextHandler(),
        stdout: new TextHandler(),
        stderr: new TextHandler(),
        status: "NA",
        process: new Runnable(),
        errorHandler: this._onProcessError.bind(this, "Solution"),
        stdoutDataHandler: this._onStdoutData.bind(this, "Solution"),
        stdoutEndHandler: this._onStdoutEnd.bind(this, "Solution"),
        stderrDataHandler: this._onStderrData.bind(this, "Solution"),
        stderrEndHandler: this._onStderrEnd.bind(this, "Solution"),
        closeHandler: this._onProcessClose.bind(this, "Solution"),
      },
      {
        state: "Judge",
        stdin: new TextHandler(),
        stdout: new TextHandler(),
        stderr: new TextHandler(),
        status: "NA",
        process: new Runnable(),
        errorHandler: this._onProcessError.bind(this, "Judge"),
        stdoutDataHandler: this._onStdoutData.bind(this, "Judge"),
        stdoutEndHandler: this._onStdoutEnd.bind(this, "Judge"),
        stderrDataHandler: this._onStderrData.bind(this, "Judge"),
        stderrEndHandler: this._onStderrEnd.bind(this, "Judge"),
        closeHandler: this._onProcessClose.bind(this, "Judge"),
      },
    ];

    this._solutionState = this._findState("Solution")!;
    this._judgeState = this._findState("Judge")!;
    this._generatorState = this._findState("Generator")!;

    // Set up callbacks to send STDIO messages to webview
    for (const state of this._state) {
      state.stdin.callback = (data: string) => {
        super._postMessage({
          type: "STDIO",
          id: state.state,
          stdio: "STDIN",
          data,
        });
      };
      state.stdout.callback = (data: string) => {
        super._postMessage({
          type: "STDIO",
          id: state.state,
          stdio: "STDOUT",
          data,
        });
      };
      state.stderr.callback = (data: string) => {
        super._postMessage({
          type: "STDIO",
          id: state.state,
          stdio: "STDERR",
          data,
        });
      };
    }

    this.onShow();
  }

  protected override _sendShowMessage(visible: boolean): void {
    super._postMessage({ type: "SHOW", visible });
  }

  protected override _switchToNoFile() {
    this.stop();
    for (const state of this._state) {
      state.stdin.reset();
      state.stdout.reset();
      state.stderr.reset();
      state.status = "NA";
    }
    this._currentFile = undefined;
    this._sendShowMessage(false);
  }

  protected override _switchToFile(file: string) {
    // Stop any running stress loop for the previous file.
    this.stop();

    this._currentFile = file;
    this._sendShowMessage(true);

    // Load persisted state from workspaceState.
    const fileData = super.readStorage()[file];
    const persistedState = v.parse(FileDataSchema, fileData ?? {});
    this._interactiveMode = persistedState.interactiveMode;
    for (const fileState of persistedState.states) {
      const state = this._findState(fileState.state);
      if (!state) continue;
      state.status = fileState.status;
      state.stdin.reset();
      state.stdout.reset();
      state.stderr.reset();
      state.stdin.write(fileState.stdin, "force");
      state.stdout.write(fileState.stdout, "force");
      state.stderr.write(fileState.stderr, "force");
    }

    // Send full state to webview.
    this._rehydrateWebviewFromState();
  }

  protected override _rehydrateWebviewFromState() {
    super._postMessage({ type: "INIT", interactiveMode: this._interactiveMode });
    super._postMessage({ type: "CLEAR" });
    for (const state of this._state) {
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
    const donePromise = this._donePromise;
    if (donePromise) {
      await donePromise;
      return;
    }

    if (!this._currentFile) {
      return;
    }

    this._donePromise = new Promise<void>((resolve) => {
      void (async () => {
        await this._doRun();
        resolve();
      })();
    });
    await this._donePromise;
    this._donePromise = null;
  }

  stop() {
    if (this._running) {
      this._stopFlag = true;
      for (const state of this._state) {
        state.process.stop();
      }
    }
  }

  private async _doRun() {
    const config = vscode.workspace.getConfiguration("fastolympiccoding");
    const delayBetweenTestcases = config.get<number>("delayBetweenTestcases")!;
    const testcaseTimeLimit = config.get<number>("stressTestcaseTimeLimit")!;
    const testcaseMemoryLimit = config.get<number>("stressTestcaseMemoryLimit")!;
    const timeLimit = config.get<number>("stressTimeLimit")!;

    const solutionSettings = getFileRunSettings(this._currentFile!);
    if (!solutionSettings) {
      return;
    }

    const generatorSettings = getFileRunSettings(solutionSettings.generatorFile!);

    let judgeSettings: FileRunSettings | null;
    if (this._interactiveMode) {
      judgeSettings = getFileRunSettings(solutionSettings.interactorFile!);
    } else {
      judgeSettings = getFileRunSettings(solutionSettings.goodSolutionFile!);
    }

    if (!generatorSettings || !judgeSettings) {
      return;
    }

    if (!solutionSettings.languageSettings.runCommand) {
      const logger = getLogger("stress");
      logger.error(`No run command for ${this._currentFile}`);
      showOpenRunSettingsErrorWindow(`No run command for ${this._currentFile}`);
      return;
    }
    if (!generatorSettings.languageSettings.runCommand) {
      const logger = getLogger("stress");
      logger.error(`No run command for ${solutionSettings.generatorFile}`);
      showOpenRunSettingsErrorWindow(`No run command for ${solutionSettings.generatorFile}`);
      return;
    }
    if (!judgeSettings.languageSettings.runCommand) {
      const logger = getLogger("stress");
      const judgeFile = this._interactiveMode
        ? solutionSettings.interactorFile!
        : solutionSettings.goodSolutionFile!;
      logger.error(`No run command for ${judgeFile}`);
      showOpenRunSettingsErrorWindow(`No run command for ${judgeFile}`);
      return;
    }

    const callback = (state: State, code: number) => {
      const status = code ? "CE" : "NA";
      state.status = status;
      super._postMessage({ type: "STATUS", id: state.state, status });

      return code;
    };
    const compilePromises: Promise<number>[] = [];
    const addCompilePromise = (state: State, file: string) => {
      const compilePromise = compile(file, this._context);
      if (compilePromise) {
        super._postMessage({
          type: "STATUS",
          id: state.state,
          status: "COMPILING",
        });
        compilePromises.push(compilePromise.then(callback.bind(this, state)));
      }
    };
    addCompilePromise(this._generatorState, solutionSettings.generatorFile!);
    addCompilePromise(this._solutionState, this._currentFile!);
    if (this._interactiveMode) {
      addCompilePromise(this._judgeState, solutionSettings.interactorFile!);
    } else {
      addCompilePromise(this._judgeState, solutionSettings.goodSolutionFile!);
    }

    const compileCodes = await Promise.all(compilePromises);
    let anyFailedToCompile = false;
    for (const code of compileCodes) {
      if (code) {
        anyFailedToCompile = true;
      }
    }
    if (anyFailedToCompile) {
      this._saveState();
      return;
    }

    for (const id of StateIdValue) {
      super._postMessage({
        type: "STATUS",
        id,
        status: "RUNNING",
      });
    }

    this._stopFlag = false;
    this._clearFlag = false;
    this._running = true;
    const start = Date.now();
    while (!this._stopFlag && (timeLimit === 0 || Date.now() - start <= timeLimit)) {
      super._postMessage({ type: "CLEAR" });
      for (const state of this._state) {
        state.stdin.reset();
        state.stdout.reset();
        state.stderr.reset();

        super._postMessage({
          type: "STATUS",
          id: state.state,
          status: "RUNNING",
        });
      }
      const seed = crypto.randomBytes(8).readBigUInt64BE();
      this._interactiveSecretPromise = new Promise<void>((resolve) => {
        this._interactorSecretResolver = resolve;
      });

      this._judgeState.process
        .on("error", this._judgeState.errorHandler)
        .on("stdout:data", this._judgeState.stdoutDataHandler)
        .on("stdout:end", this._judgeState.stdoutEndHandler)
        .on("stderr:data", this._judgeState.stderrDataHandler)
        .on("stderr:end", this._judgeState.stderrEndHandler)
        .on("close", this._judgeState.closeHandler);
      this._judgeState.process.run(
        judgeSettings.languageSettings.runCommand,
        testcaseTimeLimit,
        testcaseMemoryLimit,
        solutionSettings.languageSettings.currentWorkingDirectory
      );

      this._generatorState.process
        .on("spawn", () => {
          this._generatorState.process.stdin?.write(`${seed}\n`);
        })
        .on("error", this._generatorState.errorHandler)
        .on("stdout:data", this._generatorState.stdoutDataHandler)
        .on("stdout:end", this._generatorState.stdoutEndHandler)
        .on("stderr:data", this._generatorState.stderrDataHandler)
        .on("stderr:end", this._generatorState.stderrEndHandler)
        .on("close", this._generatorState.closeHandler);
      this._generatorState.process.run(
        generatorSettings.languageSettings.runCommand,
        0,
        0,
        solutionSettings.languageSettings.currentWorkingDirectory
      );

      this._solutionState.process
        .on("error", this._solutionState.errorHandler)
        .on("stdout:data", this._solutionState.stdoutDataHandler)
        .on("stdout:end", this._solutionState.stdoutEndHandler)
        .on("stderr:data", this._solutionState.stderrDataHandler)
        .on("stderr:end", this._solutionState.stderrEndHandler)
        .on("close", this._solutionState.closeHandler);
      this._solutionState.process.run(
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
            super._postMessage({
              type: "STATUS",
              id: state.state,
              status: state.status,
            });
            resolve(terminationSeverityNumber(termination));
          })();
        });
      };

      const generatorPromise = executionPromise(this._generatorState);
      const solutionPromise = executionPromise(this._solutionState);
      const judgePromise = executionPromise(this._judgeState);

      const severities = await Promise.all([generatorPromise, solutionPromise, judgePromise]);
      const maxSeverity = Math.max(...severities) as Severity;

      if (this._interactiveMode) {
        if (maxSeverity === 0) {
          // All the processes finished successfully, therefore the judge
          // returned 0 so the answer is correct
          this._solutionState.status = "AC";
          super._postMessage({
            type: "STATUS",
            id: this._solutionState.state,
            status: this._solutionState.status,
          });
        } else if (maxSeverity === 1) {
          // The stress tester was stopped
          break;
        } else if (
          this._solutionState.process.exitCode === null ||
          this._judgeState.process.exitCode === null
        ) {
          // The one of the two processes crashed.
          break;
        } else if (this._judgeState.process.exitCode !== 0) {
          // Judge returned non-zero code which means answer is invalid
          this._judgeState.status = "NA";
          this._solutionState.status = "WA";
          super._postMessage({
            type: "STATUS",
            id: this._judgeState.state,
            status: this._judgeState.status,
          });
          super._postMessage({
            type: "STATUS",
            id: this._solutionState.state,
            status: this._solutionState.status,
          });
          break;
        }
      } else {
        if (maxSeverity > 0) {
          // Either the stress tester was stopped or something had gone wrong
          break;
        } else if (this._solutionState.stdout.data !== this._judgeState.stdout.data) {
          this._solutionState.status = "WA";
          super._postMessage({
            type: "STATUS",
            id: this._solutionState.state,
            status: this._solutionState.status,
          });
          break;
        } else {
          this._solutionState.status = "AC";
          super._postMessage({
            type: "STATUS",
            id: this._solutionState.state,
            status: this._solutionState.status,
          });
        }
      }

      await new Promise<void>((resolve) => setTimeout(() => resolve(), delayBetweenTestcases));
    }
    this._running = false;

    if (this._clearFlag) {
      for (const state of this._state) {
        state.stdin.reset();
        state.stdout.reset();
        state.stderr.reset();
        state.status = "NA";
      }

      super._postMessage({ type: "CLEAR" });
    }
    this._clearFlag = false;

    this._saveState();
  }

  private _view({ id, stdio }: v.InferOutput<typeof ViewMessageSchema>) {
    const state = this._findState(id);
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
      resolvedFile = this._interactiveMode ? settings.interactorFile : settings.goodSolutionFile;
    }
    if (!resolvedFile) {
      return;
    }

    if (this._interactiveMode) {
      const currentState = this._findState(id);

      if (currentState?.state === "Solution") {
        this._testcaseViewProvider.addTestcaseToFile(resolvedFile, {
          uuid: crypto.randomUUID(),
          stdin: this._judgeState.stdout.data,
          stderr: this._solutionState.stderr.data + this._judgeState.stderr.data,
          stdout: this._solutionState.stdout.data,
          acceptedStdout: "",
          elapsed: currentState?.process.elapsed ?? 0,
          memoryBytes: currentState?.process.maxMemoryBytes ?? 0,
          status: currentState?.status ?? "NA",
          shown: true,
          toggled: false,
          skipped: false,
          mode: "interactive",
          interactorSecret: this._generatorState.stdout.data,
        });
      } else if (currentState?.state === "Judge") {
        // add as standard testcase easily debug the interactor from reproduced queries
        this._testcaseViewProvider.addTestcaseToFile(resolvedFile, {
          uuid: crypto.randomUUID(),
          stdin: this._generatorState.stdout.data + this._solutionState.stdout.data,
          stderr: this._solutionState.stderr.data + this._judgeState.stderr.data,
          stdout: this._judgeState.stdout.data,
          acceptedStdout: "",
          elapsed: currentState?.process.elapsed ?? 0,
          memoryBytes: currentState?.process.maxMemoryBytes ?? 0,
          status: currentState?.status ?? "NA",
          shown: true,
          toggled: false,
          skipped: false,
          mode: "standard",
          interactorSecret: this._generatorState.stdout.data,
        });
      }
    } else {
      const currentState = this._findState(id);

      this._testcaseViewProvider.addTestcaseToFile(resolvedFile, {
        uuid: crypto.randomUUID(),
        stdin: this._generatorState.stdout.data,
        stderr: currentState?.stderr.data ?? "",
        stdout: currentState?.stdout.data ?? "",
        acceptedStdout: this._judgeState.stdout.data,
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
    if (this._running) {
      this._clearFlag = true;
      this.stop();
    } else {
      for (const state of this._state) {
        state.stdin.reset();
        state.stdout.reset();
        state.stderr.reset();
        state.status = "NA";
      }

      super._postMessage({ type: "CLEAR" });
      this._saveState();
    }
  }

  _save({ interactiveMode }: v.InferOutput<typeof SaveMessageSchema>) {
    this._interactiveMode = interactiveMode;

    this._saveState();
  }

  private _saveState() {
    const file = this._currentFile;
    if (!file) {
      return;
    }

    const defaultData = v.parse(FileDataSchema, {});
    const data: FileData = {
      interactiveMode: this._interactiveMode,
      states: [],
    };
    for (const state of this._state) {
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

  private _onProcessError(stateId: StateId, data: Error) {
    if (data.name !== "AbortError") {
      const logger = getLogger("stress");
      const state = this._findState(stateId);
      logger.error(`${stateId} process error: ${data.message}`);
      state?.stderr.write(data.message, "final");
    }

    for (const stateId of StateIdValue) {
      const state = this._findState(stateId);
      state?.process.kill();
    }
  }

  private async _onStdoutData(stateId: StateId, data: string) {
    const state = this._findState(stateId);
    if (stateId === "Generator") {
      const writeMode: WriteMode = this._interactiveMode ? "force" : "batch";
      this._generatorState.stdout.write(data, writeMode);

      if (this._interactiveMode) {
        // Generator provides the secret for the interactor
        this._judgeState.process.stdin?.write(data);
      } else {
        // Generator pipes to solution and good solution
        this._solutionState.process.stdin?.write(data);
        this._judgeState.process.stdin?.write(data);
      }
    } else if (stateId === "Judge") {
      if (this._interactiveMode) {
        this._solutionState.process.stdin?.write(data);
        state?.stdout.write(data, "force");
      } else {
        state?.stdout.write(data, "batch");
      }
    } else {
      if (this._interactiveMode) {
        // Make sure generator sends the secret before sending our queries
        if (this._interactiveSecretPromise) {
          await this._interactiveSecretPromise;
          this._interactiveSecretPromise = null;
        }

        this._judgeState.process.stdin?.write(data);
        state?.stdout.write(data, "force");
      } else {
        state?.stdout.write(data, "batch");
      }
    }
  }

  private _onStdoutEnd(stateId: StateId) {
    if (this._interactiveMode && stateId === "Generator") {
      this._interactorSecretResolver?.();
      this._interactorSecretResolver = undefined;
    }

    const state = this._findState(stateId);
    state?.stdout.write("", "final");
  }

  private _onProcessClose(stateId: StateId, code: number | null) {
    const state = this._findState(stateId);
    if (!state) {
      return;
    }

    if (code !== 0) {
      for (const siblingId of StateIdValue) {
        const sibling = this._findState(siblingId);
        if (sibling && sibling.state !== stateId) {
          sibling.process.stop();
        }
      }
    }
  }

  private _onStderrData(stateId: StateId, data: string) {
    const state = this._findState(stateId);
    const writeMode: WriteMode = this._interactiveMode ? "force" : "batch";
    state?.stderr.write(data, writeMode);
  }

  private _onStderrEnd(stateId: StateId) {
    const state = this._findState(stateId);
    state?.stderr.write("", "final");
  }

  toggleWebviewSettings() {
    super._postMessage({ type: "SETTINGS_TOGGLE" });
  }
}
