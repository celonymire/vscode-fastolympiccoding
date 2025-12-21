import * as vscode from "vscode";
import * as v from "valibot";

import { Status } from "../../shared/enums";
import BaseViewProvider from "./BaseViewProvider";
import { compile, Runnable } from "../utils/runtime";
import {
  getLanguageSettings,
  openInNewEditor,
  resolveCommand,
  resolveVariables,
  TextHandler,
} from "../utils/vscode";
import { getLogger } from "../utils/logging";
import type JudgeViewProvider from "./JudgeViewProvider";
import {
  AddMessageSchema,
  ProviderMessageSchema,
  ProviderMessageType,
  ViewMessageSchema,
  type WebviewMessage,
  WebviewMessageType,
} from "../../shared/stress-messages";

const StressDataSchema = v.object({
  data: v.fallback(v.string(), ""),
  status: v.fallback(v.enum(Status), Status.NA),
});

interface IData {
  data: string;
  status: Status;
}

interface IState {
  data: TextHandler;
  status: Status;
  process: Runnable;
}

export default class extends BaseViewProvider<typeof ProviderMessageSchema, WebviewMessage> {
  private _state: IState[] = [
    { data: new TextHandler(), status: Status.NA, process: new Runnable() },
    { data: new TextHandler(), status: Status.NA, process: new Runnable() },
    { data: new TextHandler(), status: Status.NA, process: new Runnable() },
  ]; // [generator, solution, good solution]
  private _stopFlag = false;
  private _stopRequested = [false, false, false]; // track intentional stops per process
  private _clearFlag = false;
  private _running = false;
  // Context for current run (used by handlers)
  private _runCommands: string[][] = [[], [], []];
  private _runCwd: string | undefined;
  // Bound handlers (created once, reused across iterations)
  private readonly _errorHandlers: [(err: Error) => void, (err: Error) => void, (err: Error) => void];
  private readonly _stdoutDataHandlers: [(data: string) => void, (data: string) => void, (data: string) => void];
  private readonly _stdoutEndHandlers: [() => void, () => void, () => void];
  private readonly _closeHandlers: [(code: number | null) => void, (code: number | null) => void, (code: number | null) => void];

  onMessage(msg: v.InferOutput<typeof ProviderMessageSchema>): void {
    switch (msg.type) {
      case ProviderMessageType.LOADED:
        this.loadCurrentFileData();
        break;
      case ProviderMessageType.RUN:
        void this.run();
        break;
      case ProviderMessageType.STOP:
        this.stop();
        break;
      case ProviderMessageType.VIEW:
        this._view(msg);
        break;
      case ProviderMessageType.ADD:
        this._add(msg);
        break;
      case ProviderMessageType.CLEAR:
        this.clear();
        break;
    }
  }

  override onDispose() {
    super.onDispose();
    this.stop();
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

    // Initialize bound handlers once
    this._errorHandlers = [
      this._onProcessError.bind(this, 0),
      this._onProcessError.bind(this, 1),
      this._onProcessError.bind(this, 2),
    ];
    this._stdoutDataHandlers = [
      this._onStdoutData.bind(this, 0),
      this._onStdoutData.bind(this, 1),
      this._onStdoutData.bind(this, 2),
    ];
    this._stdoutEndHandlers = [
      this._onStdoutEnd.bind(this, 0),
      this._onStdoutEnd.bind(this, 1),
      this._onStdoutEnd.bind(this, 2),
    ];
    this._closeHandlers = [
      this._onProcessClose.bind(this, 0),
      this._onProcessClose.bind(this, 1),
      this._onProcessClose.bind(this, 2),
    ];

    for (let id = 0; id < 3; id++) {
      this._state[id].data.callback = (data: string) => {
        super._postMessage({
          type: WebviewMessageType.STDIO,
          id,
          data,
        });
      };
    }

    this.onShow();
  }

  protected override _sendShowMessage(visible: boolean): void {
    super._postMessage({ type: WebviewMessageType.SHOW, visible });
  }

  protected override _switchToNoFile() {
    this.stop();
    for (let id = 0; id < 3; id++) {
      this._state[id].data.reset();
      this._state[id].status = Status.NA;
      this._stopRequested[id] = false;
    }
    this._currentFile = undefined;
    this._sendShowMessage(false);
  }

  protected override _switchToFile(file: string) {
    // Stop any running stress loop for the previous file.
    this.stop();

    // Reset in-memory state.
    for (let id = 0; id < 3; id++) {
      this._state[id].data.reset();
      this._state[id].status = Status.NA;
      this._stopRequested[id] = false;
    }

    this._currentFile = file;
    this._sendShowMessage(true);

    // Load persisted state from workspaceState.
    const fileData = super.readStorage()[file];
    const arrayDataSchema = v.fallback(v.array(StressDataSchema), []);
    const state = v.parse(arrayDataSchema, fileData);
    for (let id = 0; id < Math.min(state.length, this._state.length); id++) {
      const testcase = state[id];
      this._state[id].status = testcase.status;
      this._state[id].data.reset();
      this._state[id].data.write(testcase.data, true);
    }

    // Send full state to webview.
    this._rehydrateWebviewFromState();
  }

  protected override _rehydrateWebviewFromState() {
    super._postMessage({
      type: WebviewMessageType.INIT,
      states: [
        { data: this._state[0].data.data, status: this._state[0].status },
        { data: this._state[1].data.data, status: this._state[1].status },
        { data: this._state[2].data.data, status: this._state[2].status },
      ],
    });
  }

  async run(): Promise<void> {
    const file = this._currentFile;
    if (!file) {
      return;
    }

    const config = vscode.workspace.getConfiguration("fastolympiccoding");
    const delayBetweenTestcases = config.get<number>("delayBetweenTestcases")!;

    const languageSettings = getLanguageSettings(file);
    if (!languageSettings) {
      return;
    }

    if (languageSettings.compileCommand) {
      for (let id = 0; id < 3; id++) {
        super._postMessage({
          type: WebviewMessageType.STATUS,
          id,
          status: Status.COMPILING,
        });
      }

      const callback = (id: number, code: number) => {
        const status = code ? Status.CE : Status.NA;
        this._state[id].status = status;
        super._postMessage({ type: WebviewMessageType.STATUS, id, status });
        return code;
      };
      const promises = [
        compile(
          resolveVariables(config.get("generatorFile")!),
          languageSettings.compileCommand,
          this._context
        ).then(callback.bind(this, 0)),
        compile(resolveVariables("${file}"), languageSettings.compileCommand, this._context).then(
          callback.bind(this, 1)
        ),
        compile(
          resolveVariables(config.get("goodSolutionFile")!),
          languageSettings.compileCommand,
          this._context
        ).then(callback.bind(this, 2)),
      ];
      const codes = await Promise.all(promises);

      let anyFailedToCompile = false;
      for (const code of codes) {
        if (code) {
          anyFailedToCompile = true;
          break;
        }
      }
      if (anyFailedToCompile) {
        this._saveState();
        return;
      }
    }

    for (let id = 0; id < 3; id++) {
      super._postMessage({
        type: WebviewMessageType.STATUS,
        id,
        status: Status.RUNNING,
      });
    }

    const cwd = languageSettings.currentWorkingDirectory
      ? resolveVariables(languageSettings.currentWorkingDirectory)
      : undefined;
    this._runCwd = cwd;
    const testcaseTimeLimit = config.get<number>("stressTestcaseTimeLimit")!;
    const testcaseMemoryLimit = config.get<number>("stressTestcaseMemoryLimit")!;
    const timeLimit = config.get<number>("stressTimeLimit")!;
    const start = Date.now();

    let anyFailed = false;
    this._stopFlag = false;
    for (let i = 0; i < 3; i++) {
      this._stopRequested[i] = false;
    }
    this._clearFlag = false;
    this._running = true;
    while (!this._stopFlag && (timeLimit === 0 || Date.now() - start <= timeLimit)) {
      super._postMessage({ type: WebviewMessageType.CLEAR });
      for (let i = 0; i < 3; i++) {
        this._state[i].data.reset();
      }

      const seed = Math.round(Math.random() * 9007199254740991);
      const generatorRunArguments = this._resolveRunArguments(
        languageSettings.runCommand,
        config.get("generatorFile")!
      );
      this._runCommands[0] = generatorRunArguments;
      this._state[0].process.run(
        generatorRunArguments[0],
        testcaseTimeLimit,
        testcaseMemoryLimit,
        cwd,
        ...generatorRunArguments.slice(1)
      );
      this._state[0].process.process?.on("error", this._errorHandlers[0]);
      this._state[0].process.process?.stdin.write(`${seed}\n`);
      this._state[0].process.process?.stdout.on("data", this._stdoutDataHandlers[0]);
      this._state[0].process.process?.stdout.once("end", this._stdoutEndHandlers[0]);

      const solutionRunArguments = this._resolveRunArguments(
        languageSettings.runCommand,
        "${file}"
      );
      this._runCommands[1] = solutionRunArguments;
      this._state[1].process.run(
        solutionRunArguments[0],
        testcaseTimeLimit,
        testcaseMemoryLimit,
        cwd,
        ...solutionRunArguments.slice(1)
      );
      this._state[1].process.process?.on("error", this._errorHandlers[1]);
      this._state[1].process.process?.stdout.on("data", this._stdoutDataHandlers[1]);
      this._state[1].process.process?.stdout.once("end", this._stdoutEndHandlers[1]);

      const goodSolutionRunArguments = this._resolveRunArguments(
        languageSettings.runCommand,
        config.get("goodSolutionFile")!
      );
      this._runCommands[2] = goodSolutionRunArguments;
      this._state[2].process.run(
        goodSolutionRunArguments[0],
        testcaseTimeLimit,
        testcaseMemoryLimit,
        cwd,
        ...goodSolutionRunArguments.slice(1)
      );
      this._state[2].process.process?.on("error", this._errorHandlers[2]);
      this._state[2].process.process?.stdout.on("data", this._stdoutDataHandlers[2]);
      this._state[2].process.process?.stdout.once("end", this._stdoutEndHandlers[2]);

      this._state[0].process.process?.once("close", this._closeHandlers[0]);
      this._state[1].process.process?.once("close", this._closeHandlers[1]);
      this._state[2].process.process?.once("close", this._closeHandlers[2]);

      await Promise.allSettled(this._state.map((value) => value.process.promise));
      for (let i = 0; i < 3; i++) {
        if (this._state[i].process.memoryLimitExceeded) {
          anyFailed = true;
          this._state[i].status = Status.ML;
        } else if (this._state[i].process.timedOut) {
          anyFailed = true;
          this._state[i].status = Status.TL;
        } else if (this._stopRequested[i]) {
          this._state[i].status = Status.NA;
        } else if (this._state[i].process.exitCode !== 0) {
          anyFailed = true;
          this._state[i].status = Status.RE;
        } else {
          this._state[i].status = Status.NA;
        }
      }
      if (anyFailed || this._state[1].data.data !== this._state[2].data.data) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(() => resolve(), delayBetweenTestcases));
    }
    this._running = false;

    if (this._clearFlag) {
      for (let id = 0; id < 3; id++) {
        this._state[id].data.reset();
        this._state[id].status = Status.NA;
      }

      super._postMessage({ type: WebviewMessageType.CLEAR });
    } else if (!anyFailed && this._state[1].data.data !== this._state[2].data.data) {
      this._state[1].status = Status.WA;
    }
    this._clearFlag = false;

    for (let id = 0; id < 3; id++) {
      super._postMessage({
        type: WebviewMessageType.STATUS,
        id,
        status: this._state[id].status,
      });
    }
    this._saveState();
  }

  stop() {
    if (this._running) {
      this._stopFlag = true;
      for (let i = 0; i < 3; i++) {
        this._stopRequested[i] = true;
        this._state[i].process.process?.kill();
      }
    }
  }

  private _view({ id }: v.InferOutput<typeof ViewMessageSchema>) {
    void openInNewEditor(this._state[id].data.data);
  }

  private _add({ id }: v.InferOutput<typeof AddMessageSchema>) {
    const file = this._currentFile;
    if (!file) {
      return;
    }

    let resolvedFile: string;
    if (id === 0) {
      resolvedFile = resolveVariables(
        vscode.workspace.getConfiguration("fastolympiccoding").get("generatorFile")!
      );
    } else if (id === 1) {
      resolvedFile = file;
    } else {
      resolvedFile = resolveVariables(
        vscode.workspace.getConfiguration("fastolympiccoding").get("goodSolutionFile")!
      );
    }

    this._testcaseViewProvider.addTestcaseToFile(resolvedFile, {
      stdin: this._state[0].data.data,
      stderr: "",
      stdout: this._state[1].data.data,
      acceptedStdout: this._state[2].data.data,
      elapsed: 0,
      memoryBytes: this._state[id].process.maxMemoryBytes,
      status: this._state[id].status,
      shown: true,
      toggled: false,
      skipped: false,
    });
  }

  clear() {
    if (this._running) {
      this._clearFlag = true;
      this.stop();
    } else {
      for (let id = 0; id < 3; id++) {
        this._state[id].data.reset();
        this._state[id].status = Status.NA;
      }

      super._postMessage({ type: WebviewMessageType.CLEAR });
      this._saveState();
    }
  }

  private _saveState() {
    const file = this._currentFile;
    if (!file) {
      return;
    }

    let isDefault = true;
    for (const state of this._state) {
      isDefault &&= state.data.data === "";
      isDefault &&= state.status === Status.NA;
    }
    void super.writeStorage(
      file,
      isDefault
        ? undefined
        : this._state.map<IData>((value) => ({
            data: value.data.data,
            status: value.status,
          }))
    );
  }

  private _resolveRunArguments(runCommand: string, fileVariable: string) {
    const resolvedFile = resolveVariables(fileVariable);
    const resolvedArgs = resolveCommand(runCommand, resolvedFile);
    return resolvedArgs;
  }

  private _onProcessError(processId: 0 | 1 | 2, data: Error) {
    if (data.name !== "AbortError") {
      const logger = getLogger("stress");
      const config = vscode.workspace.getConfiguration("fastolympiccoding");
      const fileLabels = [
        `generatorFile: ${config.get("generatorFile")}`,
        `solution: ${this._currentFile}`,
        `goodSolutionFile: ${config.get("goodSolutionFile")}`,
      ];
      logger.error(`${fileLabels[processId]} process error`, {
        file: this._currentFile,
        error: data.message,
        command: this._runCommands[processId],
        cwd: this._runCwd,
      });
      this._state[processId].data.write(data.message, true);
    }
  }

  private _onStdoutData(processId: 0 | 1 | 2, data: string) {
    this._state[processId].data.write(data, false);
    if (processId === 0) {
      // Generator pipes to solution and good solution
      this._state[1].process.process?.stdin.write(data);
      this._state[2].process.process?.stdin.write(data);
    }
  }

  private _onStdoutEnd(processId: 0 | 1 | 2) {
    this._state[processId].data.write("", true);
  }

  private _onProcessClose(processId: 0 | 1 | 2, code: number | null) {
    const proc = this._state[processId].process.process;
    if (!proc) return;

    // Detach listeners using stored references
    proc.off("error", this._errorHandlers[processId]);
    proc.stdout.off("data", this._stdoutDataHandlers[processId]);

    if (code === null || code) {
      // Cascade kill siblings (not user-requested stop)
      for (let i = 0; i < 3; i++) {
        if (i !== processId) {
          this._state[i].process.process?.kill();
        }
      }
    }
  }
}
