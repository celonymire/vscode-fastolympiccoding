import * as vscode from "vscode";
import * as v from "valibot";

import { ProblemSchema, TestSchema, TestcaseSchema, type Mode } from "../../shared/schemas";
import BaseViewProvider from "./BaseViewProvider";
import {
  compile,
  findAvailablePort,
  mapTestcaseTermination,
  Runnable,
  severityNumberToStatus,
  terminationSeverityNumber,
} from "../utils/runtime";
import type { RunTermination } from "../utils/runtime";
import {
  getLanguageSettings,
  openInNewEditor,
  ReadonlyStringProvider,
  resolveCommand,
  resolveVariables,
  TextHandler,
  type ILanguageSettings,
} from "../utils/vscode";
import { getLogger } from "../utils/logging";
import {
  ActionMessageSchema,
  NextMessageSchema,
  ProviderMessageSchema,
  SaveInteractorSecretMessageSchema,
  SaveMessageSchema,
  SetMemoryLimitSchema,
  SetTimeLimitSchema,
  StdinMessageSchema,
  ViewMessageSchema,
  type WebviewMessage,
} from "../../shared/judge-messages";

type IProblem = v.InferOutput<typeof ProblemSchema>;
type ITest = v.InferOutput<typeof TestSchema>;
type ITestcase = v.InferOutput<typeof TestcaseSchema>;
type FileData = v.InferOutput<typeof FileDataSchema>;

const FileDataSchema = v.fallback(
  v.object({
    timeLimit: v.fallback(v.number(), 0),
    memoryLimit: v.fallback(v.number(), 0),
    testcases: v.fallback(v.array(TestcaseSchema), []),
  }),
  { timeLimit: 0, memoryLimit: 0, testcases: [] }
);

const defaultFileData = v.parse(FileDataSchema, {});

type State = Omit<
  ITestcase,
  "stdin" | "stderr" | "stdout" | "acceptedStdout" | "interactorSecret"
> & {
  stdin: TextHandler;
  stderr: TextHandler;
  stdout: TextHandler;
  acceptedStdout: TextHandler;
  interactorSecret: TextHandler;
  id: number;
  process: Runnable;
  interactorProcess: Runnable;
  interactorSecretResolver?: () => void;
};

type LaunchTestcaseParams = {
  id: number;
  token: vscode.CancellationToken;
  testcase: State;
  resolvedArgs: string[];
  cwd?: string;
  timeout: number;
  memoryLimit: number;
};

type LaunchInteractiveTestcaseParams = Omit<LaunchTestcaseParams, "resolvedArgs"> & {
  solutionResolvedArgs: string[];
  interactorResolvedArgs: string[];
};

type ExecutionContext = {
  token: vscode.CancellationToken;
  file: string;
  testcase: State;
  languageSettings: ILanguageSettings;
};

function updateTestcaseFromTermination(state: State, termination: RunTermination) {
  state.elapsed = state.process.elapsed;
  state.memoryBytes = state.process.maxMemoryBytes;
  state.status = mapTestcaseTermination(termination);
  if (state.status === "NA") {
    // Exit succeeded; refine with output comparison
    if (state.acceptedStdout.isEmpty()) {
      state.status = "NA";
    } else if (state.stdout.data === state.acceptedStdout.data) {
      state.status = "AC";
    } else {
      state.status = "WA";
    }
  }
}

function updateInteractiveTestcaseFromTermination(
  state: State,
  termination: RunTermination,
  interactorTermination: RunTermination
) {
  state.elapsed = state.process.elapsed;
  state.memoryBytes = state.process.maxMemoryBytes;
  state.status = severityNumberToStatus(
    Math.max(
      terminationSeverityNumber(termination),
      terminationSeverityNumber(interactorTermination)
    )
  );
  if (state.status === "NA") {
    // Exit succeeded; refine with output comparison
    if (state.acceptedStdout.isEmpty()) {
      state.status = "NA";
    } else if (state.stdout.data === state.acceptedStdout.data) {
      state.status = "AC";
    } else {
      state.status = "WA";
    }
  }
}

export default class extends BaseViewProvider<typeof ProviderMessageSchema, WebviewMessage> {
  private _state: State[] = [];
  private _timeLimit = 0;
  private _memoryLimit = 0;
  private _newId = 0;
  private _fileCancellation?: vscode.CancellationTokenSource;
  private _activeDebugTestcaseId?: number;

  private async _getExecutionContext(id: number): Promise<ExecutionContext | undefined> {
    const token = this._fileCancellation?.token;
    if (!token || token.isCancellationRequested) {
      return;
    }

    const file = this._currentFile;
    if (!file) {
      return;
    }

    const testcase = this._getTestcase(id);
    if (!testcase) {
      return;
    }

    // stop already-running process
    this._stop(id);
    await testcase.process.done;

    if (token.isCancellationRequested || testcase.skipped) {
      return;
    }

    const languageSettings = await getLanguageSettings(file);
    if (!languageSettings) {
      return;
    }

    return { token, file, testcase, languageSettings };
  }

  private async _compileIfNeeded(
    id: number,
    token: vscode.CancellationToken,
    file: string,
    testcase: State,
    languageSettings: ILanguageSettings
  ): Promise<boolean> {
    if (!languageSettings.compileCommand) {
      return false;
    }

    testcase.status = "COMPILING";
    super._postMessage({
      type: "SET",
      id,
      property: "status",
      value: "COMPILING",
    });

    const code = await compile(file, languageSettings.compileCommand, this._context);

    if (!token.isCancellationRequested && code) {
      testcase.status = "CE";
      super._postMessage({
        type: "SET",
        id,
        property: "status",
        value: "CE",
      });
      this._saveFileData();
      return true;
    }

    return token.isCancellationRequested;
  }

  private _prepareRunningState(id: number, testcase: State) {
    testcase.status = "RUNNING";
    super._postMessage({
      type: "SET",
      id,
      property: "status",
      value: "RUNNING",
    });
    if (testcase.mode === "interactive") {
      testcase.stdin.reset();
      super._postMessage({
        type: "SET",
        id,
        property: "stdin",
        value: "",
      });
    }
    testcase.stderr.reset();
    super._postMessage({
      type: "SET",
      id,
      property: "stderr",
      value: "",
    });
    testcase.stdout.reset();
    super._postMessage({
      type: "SET",
      id,
      property: "stdout",
      value: "",
    });
  }

  private _launchTestcase(params: LaunchTestcaseParams) {
    const { id, token, testcase, resolvedArgs, cwd, timeout, memoryLimit } = params;

    testcase.process.run(resolvedArgs[0], timeout, memoryLimit, cwd, ...resolvedArgs.slice(1));

    const proc = testcase.process.process;
    if (!proc) {
      return;
    }

    // Write stdin once the process is spawned (more reliable than writing immediately).
    testcase.process.on("spawn", () => {
      if (token.isCancellationRequested) {
        return;
      }
      proc.stdin.write(testcase.stdin.data);
    });

    testcase.process
      .on("stderr:data", (data: string) => testcase.stderr.write(data, false))
      .on("stdout:data", (data: string) => testcase.stdout.write(data, false))
      .on("stderr:end", () => testcase.stderr.write("", true))
      .on("stdout:end", () => testcase.stdout.write("", true))
      .on("error", (data: Error) => {
        if (token.isCancellationRequested) {
          return;
        }
        const logger = getLogger("judge");
        logger.error(
          `Process error during testcase execution (testcaseId=${id}, file=${this._currentFile ?? "undefined"}, error=${data.message}, command=${proc.spawnargs.join(" ")})`
        );
        testcase.stderr.write(data.message, true);
        testcase.status = "RE";
        super._postMessage({
          type: "SET",
          id,
          property: "status",
          value: "RE",
        });
        this._saveFileData();
      })
      .on("close", async () => {
        if (token.isCancellationRequested) {
          return;
        }
        const termination = await testcase.process.done;
        updateTestcaseFromTermination(testcase, termination);
        super._postMessage({
          type: "SET",
          id,
          property: "status",
          value: testcase.status,
        });
        super._postMessage({
          type: "SET",
          id,
          property: "elapsed",
          value: testcase.elapsed,
        });
        super._postMessage({
          type: "SET",
          id,
          property: "memoryBytes",
          value: testcase.memoryBytes,
        });

        this._saveFileData();
      });
  }

  private async _launchInteractiveTestcase(params: LaunchInteractiveTestcaseParams) {
    const {
      id,
      token,
      testcase,
      solutionResolvedArgs,
      interactorResolvedArgs,
      cwd,
      timeout,
      memoryLimit,
    } = params;

    testcase.process.run(
      solutionResolvedArgs[0],
      timeout,
      memoryLimit,
      cwd,
      ...solutionResolvedArgs.slice(1)
    );
    testcase.interactorProcess.run(
      interactorResolvedArgs[0],
      0,
      0,
      cwd,
      ...interactorResolvedArgs.slice(1)
    );

    const proc = testcase.process.process;
    const interactorProc = testcase.interactorProcess.process;
    if (!proc || !interactorProc) {
      return;
    }

    // Pass the secret input before the outputs of the solution
    // This is a deliberate design choice to allow minimal changes to adapt
    // to various online judges, where the secret answer can come from various
    // places, e.g. dynamic filename (CodeForces) or fixed filename (others).
    // Use a promise to execute this strategy
    const secretPromise = new Promise<void>((resolve) => {
      testcase.interactorSecretResolver = resolve;
    });

    testcase.interactorProcess
      .on("spawn", async () => {
        if (testcase.interactorSecret.isEmpty()) {
          await secretPromise;
        } else {
          testcase.interactorSecretResolver?.();
          testcase.interactorSecretResolver = undefined;
        }
        interactorProc.stdin.write(testcase.interactorSecret.data);
      })
      .on("stderr:data", (data: string) => testcase.stderr.write(data, false))
      .on("stdout:data", (data: string) => {
        testcase.stdin.write(data, false);
        proc.stdin.write(data);
      })
      .on("error", (data: Error) => {
        if (token.isCancellationRequested) {
          return;
        }
        const logger = getLogger("judge");
        logger.error(
          `Process error during testcase execution (testcaseId=${id}, file=${this._currentFile ?? "undefined"}, error=${data.message}, command=${proc.spawnargs.join(" ")})`
        );
        testcase.stderr.write("=== INTERACTOR ERROR ===\n", false);
        testcase.stderr.write(data.message, true);
        testcase.status = "RE";
      });

    testcase.process
      .on("stderr:data", (data: string) => testcase.stderr.write(data, false))
      .on("stdout:data", async (data: string) => {
        if (testcase.interactorSecretResolver) {
          await secretPromise;
        }
        testcase.stdout.write(data, false);
        interactorProc.stdin.write(data);
      })
      .on("error", (data: Error) => {
        if (token.isCancellationRequested) {
          return;
        }
        const logger = getLogger("judge");
        logger.error(
          `Process error during testcase execution (testcaseId=${id}, file=${this._currentFile ?? "undefined"}, error=${data.message}, command=${proc.spawnargs.join(" ")})`
        );
        testcase.stderr.write("=== SOLUTION ERROR ===\n", false);
        testcase.stderr.write(data.message, true);
      });

    const [termination, interactorTermination] = await Promise.all([
      testcase.process.done,
      testcase.interactorProcess.done,
    ]);

    testcase.stdin.write("", true);
    testcase.stderr.write("", true);
    testcase.stdout.write("", true);

    updateInteractiveTestcaseFromTermination(testcase, termination, interactorTermination);
    super._postMessage({
      type: "SET",
      id,
      property: "status",
      value: testcase.status,
    });
    super._postMessage({
      type: "SET",
      id,
      property: "elapsed",
      value: testcase.elapsed,
    });
    super._postMessage({
      type: "SET",
      id,
      property: "memoryBytes",
      value: testcase.memoryBytes,
    });

    this._saveFileData();
  }

  onMessage(msg: v.InferOutput<typeof ProviderMessageSchema>) {
    switch (msg.type) {
      case "LOADED":
        this.loadCurrentFileData();
        break;
      case "NEXT":
        this._nextTestcase(msg);
        break;
      case "ACTION":
        this._action(msg);
        break;
      case "SAVE":
        this._save(msg);
        break;
      case "SAVE_INTERACTOR_SECRET":
        this._saveInteractorSecret(msg);
        break;
      case "VIEW":
        this._viewStdio(msg);
        break;
      case "STDIN":
        this._stdin(msg);
        break;
      case "TL":
        this._setTimeLimit(msg);
        break;
      case "ML":
        this._setMemoryLimit(msg);
        break;
    }
  }

  override onDispose() {
    super.onDispose();
    this._fileCancellation?.cancel();
    this._fileCancellation?.dispose();
    this._fileCancellation = undefined;
    this.stopAll();
  }

  onShow() {
    this._ensureActiveEditorListener();
    this._syncOrSwitchToTargetFile();
  }

  constructor(context: vscode.ExtensionContext) {
    super("judge", context, ProviderMessageSchema);

    context.subscriptions.push(
      vscode.debug.onDidStartDebugSession((session) => {
        const id = session.configuration?.fastolympiccodingTestcaseId;
        if (typeof id !== "number") {
          return;
        }
        this._activeDebugTestcaseId = id;
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        const id = session.configuration?.fastolympiccodingTestcaseId;
        if (typeof id === "number" && this._activeDebugTestcaseId === id) {
          this._stop(id);
          this._activeDebugTestcaseId = undefined;
        }
      })
    );

    this.onShow();
  }

  // Judge has state if there are testcases loaded
  protected override _hasState(): boolean {
    return this._state.length > 0 || this._timeLimit !== 0 || this._memoryLimit !== 0;
  }

  protected override _sendShowMessage(visible: boolean): void {
    super._postMessage({ type: "SHOW", visible });
  }

  protected override _switchToNoFile() {
    this._fileCancellation?.cancel();
    this._fileCancellation?.dispose();
    this._fileCancellation = undefined;

    this.stopAll();
    for (const testcase of this._state) {
      super._postMessage({ type: "DELETE", id: testcase.id });
    }
    this._state = [];
    this._timeLimit = 0;
    this._memoryLimit = 0;
    this._newId = 0;
    this._currentFile = undefined;

    this._sendShowMessage(false);
  }

  protected override _switchToFile(file: string) {
    // Cancel any in-flight operations for the previous file
    this._fileCancellation?.cancel();
    this._fileCancellation?.dispose();
    this._fileCancellation = new vscode.CancellationTokenSource();

    // Stop any processes tied to the previous file, and clear state/webview.
    this.stopAll();
    for (const testcase of this._state) {
      super._postMessage({ type: "DELETE", id: testcase.id });
    }
    this._state = [];
    this._timeLimit = 0;
    this._memoryLimit = 0;
    this._newId = 0;

    this._currentFile = file;
    this._sendShowMessage(true);

    const storageData = super.readStorage()[file];
    const fileData = v.parse(FileDataSchema, storageData);
    const testcases = fileData.testcases;
    this._timeLimit = fileData.timeLimit;
    this._memoryLimit = fileData.memoryLimit;
    for (let i = 0; i < testcases.length; i++) {
      const testcase = v.parse(TestcaseSchema, testcases[i]);
      this._addTestcase(testcase.mode, testcase);
    }

    super._postMessage({
      type: "INITIAL_STATE",
      timeLimit: this._timeLimit,
      memoryLimit: this._memoryLimit,
    });
  }

  protected override _rehydrateWebviewFromState() {
    super._postMessage({
      type: "INITIAL_STATE",
      timeLimit: this._timeLimit,
      memoryLimit: this._memoryLimit,
    });

    for (const testcase of this._state) {
      const id = testcase.id;

      // Ensure a clean slate for this id in the webview.
      super._postMessage({ type: "DELETE", id });
      super._postMessage({ type: "NEW", id });

      super._postMessage({
        type: "SET",
        id,
        property: "stdin",
        value: testcase.stdin.data,
      });
      super._postMessage({
        type: "SET",
        id,
        property: "stderr",
        value: testcase.stderr.data,
      });
      super._postMessage({
        type: "SET",
        id,
        property: "stdout",
        value: testcase.stdout.data,
      });
      super._postMessage({
        type: "SET",
        id,
        property: "acceptedStdout",
        value: testcase.acceptedStdout.data,
      });
      super._postMessage({
        type: "SET",
        id,
        property: "elapsed",
        value: testcase.elapsed,
      });
      super._postMessage({
        type: "SET",
        id,
        property: "memoryBytes",
        value: testcase.memoryBytes,
      });
      super._postMessage({
        type: "SET",
        id,
        property: "status",
        value: testcase.status,
      });
      super._postMessage({
        type: "SET",
        id,
        property: "shown",
        value: testcase.shown,
      });
      super._postMessage({
        type: "SET",
        id,
        property: "toggled",
        value: testcase.toggled,
      });
      super._postMessage({
        type: "SET",
        id,
        property: "skipped",
        value: testcase.skipped,
      });
      super._postMessage({
        type: "SET",
        id,
        property: "mode",
        value: testcase.mode,
      });
      super._postMessage({
        type: "SET",
        id,
        property: "interactorSecret",
        value: testcase.interactorSecret.data,
      });
    }
  }

  addFromCompetitiveCompanion(file: string, data: IProblem) {
    const testcases: ITestcase[] = data.tests.map(
      (test: ITest): ITestcase => ({
        stdin: test.input,
        stderr: "",
        stdout: "",
        acceptedStdout: test.output,
        elapsed: 0,
        memoryBytes: 0,
        status: "WA",
        shown: true,
        toggled: false,
        skipped: false,
        mode: data.interactive ? "interactive" : "standard",
        interactorSecret: "", // Competitive Companion doesn't provide interactor secret
      })
    );

    const current = this._currentFile ?? vscode.window.activeTextEditor?.document.fileName;
    if (file === current) {
      this.deleteAll();
      this._timeLimit = data.timeLimit;
      this._memoryLimit = data.memoryLimit;
      for (const testcase of testcases) {
        this._addTestcase(data.interactive ? "interactive" : "standard", testcase);
      }
      this._saveFileData();

      super._postMessage({
        type: "INITIAL_STATE",
        timeLimit: data.timeLimit,
        memoryLimit: data.memoryLimit,
      });
    } else {
      const fileData: FileData = {
        timeLimit: data.timeLimit,
        memoryLimit: data.memoryLimit,
        testcases,
      };
      void super.writeStorage(file, fileData);
    }
  }

  addTestcaseToFile(file: string, testcase: ITestcase) {
    // used by stress view

    const current = this._currentFile ?? vscode.window.activeTextEditor?.document.fileName;
    if (file === current) {
      this._addTestcase("standard", testcase); // FIXME: Properly set interactive parameter when stress tester is updated
      this._saveFileData();
    } else {
      const storageData = super.readStorage()[file];
      const parseResult = v.safeParse(FileDataSchema, storageData);
      const fileData = parseResult.success
        ? parseResult.output
        : { timeLimit: 0, memoryLimit: 0, testcases: [] };
      const testcases = fileData.testcases || [];
      testcases.push(testcase);
      const data: FileData = {
        timeLimit: fileData.timeLimit ?? 0,
        memoryLimit: fileData.memoryLimit ?? 0,
        testcases,
      };
      void super.writeStorage(file, data);
    }
  }

  runAll() {
    for (const testcase of this._state) {
      void this._run(testcase.id, false);
    }
  }

  debugAll() {
    for (const testcase of this._state) {
      void this._debug(testcase.id);
    }
  }

  stopAll() {
    for (const testcase of this._state) {
      this._stop(testcase.id);
    }
  }

  deleteAll() {
    for (const testcase of this._state) {
      this._delete(testcase.id);
    }
  }

  saveAll() {
    super._postMessage({ type: "SAVE_ALL" });
  }

  toggleWebviewSettings() {
    super._postMessage({ type: "SETTINGS_TOGGLE" });
  }

  private _nextTestcase({ mode }: v.InferOutput<typeof NextMessageSchema>) {
    void this._run(this._addTestcase(mode, {}), true);
  }

  private _action({ id, action }: v.InferOutput<typeof ActionMessageSchema>) {
    switch (action) {
      case "RUN":
        void this._run(id, false);
        break;
      case "DEBUG":
        void this._debug(id);
        break;
      case "STOP":
        this._stop(id);
        break;
      case "DELETE":
        this._delete(id);
        break;
      case "EDIT":
        this._edit(id);
        break;
      case "ACCEPT":
        this._accept(id);
        break;
      case "DECLINE":
        this._decline(id);
        break;
      case "TOGGLE_VISIBILITY":
        this._toggleVisibility(id);
        break;
      case "TOGGLE_SKIP":
        this._toggleSkip(id);
        break;
      case "COMPARE":
        this._compare(id);
        break;
    }
  }

  private _saveFileData() {
    const file = this._currentFile;
    if (!file) {
      return;
    }

    const testcases: ITestcase[] = [];
    for (const testcase of this._state) {
      testcases.push({
        stdin: testcase.stdin.data,
        stderr: testcase.stderr.data,
        stdout: testcase.stdout.data,
        acceptedStdout: testcase.acceptedStdout.data,
        elapsed: testcase.elapsed,
        memoryBytes: testcase.memoryBytes,
        status: testcase.status,
        shown: testcase.shown,
        toggled: testcase.toggled,
        skipped: testcase.skipped,
        mode: testcase.mode,
        interactorSecret: testcase.interactorSecret.data,
      });
    }
    const fileData: FileData = {
      timeLimit: this._timeLimit,
      memoryLimit: this._memoryLimit,
      testcases,
    };
    void super.writeStorage(
      file,
      JSON.stringify(fileData) === JSON.stringify(defaultFileData) ? undefined : fileData
    );
  }

  private _addTestcase(mode: Mode, testcase?: Partial<ITestcase>) {
    const id = this._newId++;
    this._state.push(this._createTestcaseState(id, mode, testcase));
    return id;
  }

  private _createTestcaseState(id: number, mode: Mode, testcase?: Partial<ITestcase>) {
    // using partial type to have backward compatibility with old testcases
    // create a new testcase in webview and fill it in later
    super._postMessage({ type: "NEW", id });

    const newTestcase: State = {
      stdin: new TextHandler(),
      stderr: new TextHandler(),
      stdout: new TextHandler(),
      acceptedStdout: new TextHandler(),
      elapsed: testcase?.elapsed ?? 0,
      memoryBytes: testcase?.memoryBytes ?? 0,
      status: testcase?.status ?? "NA",
      shown: testcase?.shown ?? true,
      toggled: testcase?.toggled ?? false,
      skipped: testcase?.skipped ?? false,
      mode: testcase?.mode ?? mode,
      interactorSecret: new TextHandler(),
      id,
      process: new Runnable(),
      interactorProcess: new Runnable(),
      interactorSecretResolver: undefined,
    };

    newTestcase.stdin.callback = (data: string) =>
      super._postMessage({
        type: "STDIO",
        id,
        stdio: "STDIN",
        data,
      });
    newTestcase.stderr.callback = (data: string) =>
      super._postMessage({
        type: "STDIO",
        id,
        stdio: "STDERR",
        data,
      });
    newTestcase.stdout.callback = (data: string) =>
      super._postMessage({
        type: "STDIO",
        id,
        stdio: "STDOUT",
        data,
      });
    newTestcase.acceptedStdout.callback = (data: string) =>
      super._postMessage({
        type: "STDIO",
        id,
        stdio: "ACCEPTED_STDOUT",
        data,
      });
    newTestcase.interactorSecret.callback = (data: string) =>
      super._postMessage({
        type: "STDIO",
        id,
        stdio: "INTERACTOR_SECRET",
        data,
      });

    newTestcase.stdin.write(testcase?.stdin ?? "", !!testcase);
    newTestcase.stderr.write(testcase?.stderr ?? "", !!testcase);
    newTestcase.stdout.write(testcase?.stdout ?? "", !!testcase);
    newTestcase.acceptedStdout.write(testcase?.acceptedStdout ?? "", true); // force endline for empty answer comparison
    // We treat interactor secrets as final because there are problems where
    // the solution queries the interactor without reading any input first. The
    // best assumption is to send the complete secret at the start.
    newTestcase.interactorSecret.write(testcase?.interactorSecret ?? "", true);

    super._postMessage({
      type: "SET",
      id,
      property: "status",
      value: newTestcase.status,
    });
    super._postMessage({
      type: "SET",
      id,
      property: "elapsed",
      value: newTestcase.elapsed,
    });
    super._postMessage({
      type: "SET",
      id,
      property: "memoryBytes",
      value: newTestcase.memoryBytes,
    });
    super._postMessage({
      type: "SET",
      id,
      property: "shown",
      value: newTestcase.shown,
    });
    super._postMessage({
      type: "SET",
      id,
      property: "toggled",
      value: newTestcase.toggled,
    });
    super._postMessage({
      type: "SET",
      id,
      property: "skipped",
      value: newTestcase.skipped,
    });
    super._postMessage({
      type: "SET",
      id,
      property: "mode",
      value: newTestcase.mode,
    });

    return newTestcase;
  }

  private async _run(id: number, newTestcase: boolean): Promise<void> {
    const ctx = await this._getExecutionContext(id);
    if (!ctx) {
      return;
    }

    const { token, file, testcase, languageSettings } = ctx;

    const compilePromises = [this._compileIfNeeded(id, token, file, testcase, languageSettings)];

    let interactorFile: string | undefined;
    if (testcase.mode === "interactive") {
      const config = vscode.workspace.getConfiguration("fastolympiccoding");
      const interactorFileFromConfig = config.get<string>("interactorFile");
      if (!interactorFileFromConfig) {
        const logger = getLogger("judge");
        logger.error(`Interactor file not set for interactive testcase (file=${file})`);
        vscode.window.showErrorMessage(
          "Interactor file is not set. Please set it in the Fast Olympic Coding settings."
        );
        return;
      }
      interactorFile = resolveVariables(interactorFileFromConfig);
      compilePromises.push(
        this._compileIfNeeded(id, token, interactorFile, testcase, languageSettings)
      );
    }
    const errored = await Promise.all(compilePromises);
    for (const hadError of errored) {
      if (hadError) {
        return;
      }
    }
    if (token.isCancellationRequested) {
      return;
    }

    this._prepareRunningState(id, testcase);

    if (testcase.mode === "interactive") {
      const solutionResolvedArgs = resolveCommand(languageSettings.runCommand);
      const interactorResolvedArgs = resolveCommand(languageSettings.runCommand, interactorFile);
      const cwd = languageSettings.currentWorkingDirectory
        ? resolveVariables(languageSettings.currentWorkingDirectory)
        : undefined;

      this._launchInteractiveTestcase({
        id,
        token,
        testcase,
        solutionResolvedArgs,
        interactorResolvedArgs,
        cwd,
        timeout: newTestcase ? 0 : this._timeLimit,
        memoryLimit: newTestcase ? 0 : this._memoryLimit,
      });
    } else {
      const resolvedArgs = resolveCommand(languageSettings.runCommand);
      const cwd = languageSettings.currentWorkingDirectory
        ? resolveVariables(languageSettings.currentWorkingDirectory)
        : undefined;

      this._launchTestcase({
        id,
        token,
        testcase,
        resolvedArgs,
        cwd,
        timeout: newTestcase ? 0 : this._timeLimit,
        memoryLimit: newTestcase ? 0 : this._memoryLimit,
      });
    }
  }

  private async _debug(id: number): Promise<void> {
    const ctx = await this._getExecutionContext(id);
    if (!ctx) {
      return;
    }

    const { token, file, testcase, languageSettings } = ctx;

    if (!languageSettings.debugCommand || !languageSettings.debugAttachConfig) {
      const logger = getLogger("judge");
      logger.error(
        `Debug settings missing for language (file=${file}, hasDebugCommand=${!!languageSettings.debugCommand}, hasDebugAttachConfig=${!!languageSettings.debugAttachConfig})`
      );
      vscode.window.showErrorMessage("Missing debug settings for this language.");
      return;
    }

    const compilePromises = [this._compileIfNeeded(id, token, file, testcase, languageSettings)];

    let interactorFile: string | undefined;
    if (testcase.mode === "interactive") {
      const config = vscode.workspace.getConfiguration("fastolympiccoding");
      const interactorFileFromConfig = config.get<string>("interactorFile");
      if (!interactorFileFromConfig) {
        const logger = getLogger("judge");
        logger.error(`Interactor file not set for interactive testcase (file=${file})`);
        vscode.window.showErrorMessage(
          "Interactor file is not set. Please set it in the Fast Olympic Coding settings."
        );
        return;
      }
      interactorFile = resolveVariables(interactorFileFromConfig);
      compilePromises.push(
        this._compileIfNeeded(id, token, interactorFile, testcase, languageSettings)
      );
    }
    const errored = await Promise.all(compilePromises);
    for (const hadError of errored) {
      if (hadError) {
        return;
      }
    }
    if (token.isCancellationRequested) {
      return;
    }

    // Generate a dynamic port for this debug session
    let debugPort: number;
    try {
      debugPort = await findAvailablePort();
    } catch (error) {
      const logger = getLogger("judge");
      logger.error(
        `Failed to allocate debug port (file=${file}, testcaseId=${id}, error=${error instanceof Error ? error.message : String(error)})`
      );
      vscode.window.showErrorMessage(
        `Failed to find available port for debugging: ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }
    const extraVariables = { debugPort: String(debugPort) };

    // get the attach debug configuration
    const folder =
      vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file)) ??
      vscode.workspace.workspaceFolders?.at(0);
    const attachConfig = vscode.workspace
      .getConfiguration("launch", folder)
      .get<vscode.DebugConfiguration[]>("configurations", [])
      .find((config) => config.name === languageSettings.debugAttachConfig);
    if (!attachConfig) {
      const logger = getLogger("judge");
      logger.warn(`Debug attach configuration not found: ${languageSettings.debugAttachConfig}`);
      vscode.window.showWarningMessage("Debug attach configuration not found.");
      return;
    }

    const resolvedArgs = resolveCommand(languageSettings.debugCommand, file, extraVariables);
    const cwd = languageSettings.currentWorkingDirectory
      ? resolveVariables(languageSettings.currentWorkingDirectory, file, extraVariables)
      : undefined;

    this._prepareRunningState(id, testcase);

    // No limits for debugging; user stops it manually.
    if (testcase.mode === "interactive") {
      const solutionResolvedArgs = resolveCommand(
        languageSettings.debugCommand,
        file,
        extraVariables
      );
      const interactorResolvedArgs = resolveCommand(languageSettings.runCommand, interactorFile);
      const cwd = languageSettings.currentWorkingDirectory
        ? resolveVariables(languageSettings.currentWorkingDirectory)
        : undefined;

      this._launchInteractiveTestcase({
        id,
        token,
        testcase,
        solutionResolvedArgs,
        interactorResolvedArgs,
        cwd,
        timeout: 0,
        memoryLimit: 0,
      });
    } else {
      const resolvedArgs = resolveCommand(languageSettings.debugCommand, file, extraVariables);
      const cwd = languageSettings.currentWorkingDirectory
        ? resolveVariables(languageSettings.currentWorkingDirectory)
        : undefined;

      this._launchTestcase({
        id,
        token,
        testcase,
        resolvedArgs,
        cwd,
        timeout: 0,
        memoryLimit: 0,
      });
    }

    // Wait for the debug process to spawn before attaching
    const spawnedPromises = [testcase.process.spawned];
    if (testcase.mode === "interactive") {
      spawnedPromises.push(testcase.interactorProcess.spawned);
    }
    const spawned = await Promise.all(spawnedPromises);
    let allSpawned = true;
    for (const spawnedProcess of spawned) {
      if (!spawnedProcess) {
        allSpawned = false;
        break;
      }
    }
    if (!allSpawned || token.isCancellationRequested) {
      await testcase.process.done;
      const exitCode = testcase.process.exitCode;
      const signal = testcase.process.signal;
      const logger = getLogger("judge");
      logger.error(
        `Debug process failed to spawn (file=${file}, testcaseId=${id}, command=${resolvedArgs.join(" ")}, cwd=${cwd ?? "undefined"}, exitCode=${exitCode}, signal=${signal ?? "null"})`
      );
      vscode.window.showErrorMessage(
        `Debug process failed to start (exit code ${exitCode}, signal ${signal})`
      );
      return;
    }

    // resolve the values in the attach configuration
    const resolvedConfig = resolveVariables(attachConfig, file, extraVariables);

    // Tag this debug session so we can identify which testcase is being debugged.
    // VS Code preserves custom fields on session.configuration.
    resolvedConfig.fastolympiccodingTestcaseId = id;

    // Slight delay to ensure process is listening
    // This is less than ideal because it relies on timing, but there is no reliable way
    // to detect when the debug server is ready without attempting a connection. If we try
    // to connect as a client, we might interfere with the debug session because the server
    // treats the first connection as the debuggee. I also tried to check if the port is listening
    // via platform specific means, but then I ran into the problem of mismatching PIDs and
    // the server running in IPv6 vs IPv4 mode.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // The configuration is user-provided, and may be invalid. Let VS Code handle validation.
    // We just need to bypass our type system here.
    const started = await vscode.debug.startDebugging(
      folder,
      resolvedConfig as vscode.DebugConfiguration
    );
    if (!started) {
      this._stop(id);
    }
  }

  private _stop(id: number) {
    const testcase = this._getTestcase(id);
    if (!testcase) {
      return;
    }

    // If this testcase is the one currently being debugged, stop the VS Code debug session.
    // This is more reliable than killing the spawned debug-wrapper process alone.
    if (this._activeDebugTestcaseId === id && vscode.debug.activeDebugSession) {
      void vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
    }

    testcase.process.process?.kill();
    testcase.interactorProcess.process?.kill();
  }

  private _delete(id: number) {
    this._stop(id);
    super._postMessage({ type: "DELETE", id });
    const idx = this._state.findIndex((t) => t.id === id);
    if (idx !== -1) {
      this._state.splice(idx, 1);
    }
    this._saveFileData();
  }

  private _edit(id: number) {
    const testcase = this._getTestcase(id);
    if (!testcase) {
      return;
    }
    testcase.status = "EDITING";
    super._postMessage({
      type: "SET",
      id,
      property: "status",
      value: "EDITING",
    });
    super._postMessage({
      type: "SET",
      id,
      property: "stdin",
      value: testcase.stdin.data,
    });
    super._postMessage({
      type: "SET",
      id,
      property: "acceptedStdout",
      value: testcase.acceptedStdout.data,
    });
  }

  private _accept(id: number) {
    const testcase = this._getTestcase(id);
    if (!testcase) {
      return;
    }

    testcase.status = "AC";
    // shortened version will be sent back while writing
    super._postMessage({
      type: "SET",
      id,
      property: "status",
      value: testcase.status,
    });
    super._postMessage({
      type: "SET",
      id,
      property: "acceptedStdout",
      value: "",
    });
    testcase.acceptedStdout.reset();
    testcase.acceptedStdout.write(testcase.stdout.data, true);

    this._saveFileData();
  }

  private _decline(id: number) {
    const testcase = this._getTestcase(id);
    if (!testcase) {
      return;
    }

    testcase.status = "NA";
    testcase.acceptedStdout.reset();
    super._postMessage({
      type: "SET",
      id,
      property: "status",
      value: testcase.status,
    });
    super._postMessage({
      type: "SET",
      id,
      property: "acceptedStdout",
      value: "",
    });
    this._saveFileData();
  }

  private _toggleVisibility(id: number) {
    const testcase = this._getTestcase(id);
    if (!testcase) {
      return;
    }

    testcase.shown = testcase.toggled ? !testcase.shown : testcase.status === "AC";
    testcase.toggled = true;
    super._postMessage({
      type: "SET",
      id,
      property: "shown",
      value: testcase.shown,
    });
    super._postMessage({
      type: "SET",
      id,
      property: "toggled",
      value: true,
    });
    this._saveFileData();
  }

  private _toggleSkip(id: number) {
    const testcase = this._getTestcase(id);
    if (!testcase) {
      return;
    }

    testcase.skipped = !testcase.skipped;
    super._postMessage({
      type: "SET",
      id,
      property: "skipped",
      value: testcase.skipped,
    });
    this._saveFileData();
  }

  private _compare(id: number) {
    const testcase = this._getTestcase(id);
    if (!testcase) {
      return;
    }
    const stdout = ReadonlyStringProvider.createUri(`OUTPUT:\n\n${testcase.stdout.data}`);
    const acStdout = ReadonlyStringProvider.createUri(
      `ACCEPTED OUTPUT:\n\n${testcase.acceptedStdout.data}`
    );

    vscode.commands.executeCommand("vscode.diff", stdout, acStdout, `Diff: Testcase #${id + 1}`);
  }

  private _viewStdio({ id, stdio }: v.InferOutput<typeof ViewMessageSchema>) {
    const testcase = this._getTestcase(id);
    if (!testcase) {
      return;
    }

    switch (stdio) {
      case "STDIN":
        void openInNewEditor(testcase.stdin.data);
        break;
      case "STDERR":
        void openInNewEditor(testcase.stderr.data);
        break;
      case "STDOUT":
        void openInNewEditor(testcase.stdout.data);
        break;
      case "ACCEPTED_STDOUT":
        void openInNewEditor(testcase.acceptedStdout.data);
        break;
      case "INTERACTOR_SECRET":
        void openInNewEditor(testcase.interactorSecret.data);
        break;
    }
  }

  private _stdin({ id, data }: v.InferOutput<typeof StdinMessageSchema>) {
    const testcase = this._getTestcase(id);
    if (!testcase) {
      return;
    }

    if (testcase.mode === "interactive") {
      testcase.interactorProcess.process?.stdin.write(data);
    } else {
      testcase.process.process?.stdin.write(data);
    }
    testcase.stdin.write(data, false);
  }

  private _save({ id, stdin, acceptedStdout }: v.InferOutput<typeof SaveMessageSchema>) {
    const testcase = this._getTestcase(id);
    if (!testcase) {
      return;
    }

    super._postMessage({
      type: "SET",
      id,
      property: "stdin",
      value: "",
    });
    super._postMessage({
      type: "SET",
      id,
      property: "acceptedStdout",
      value: "",
    });

    testcase.stdin.reset();
    testcase.acceptedStdout.reset();
    testcase.stdin.write(stdin, true);
    testcase.acceptedStdout.write(acceptedStdout, true);

    // Manual save: determine status from output comparison only
    if (testcase.acceptedStdout.data === "\n") {
      testcase.status = "NA";
    } else if (testcase.stdout.data === testcase.acceptedStdout.data) {
      testcase.status = "AC";
    } else {
      testcase.status = "WA";
    }

    super._postMessage({
      type: "SET",
      id,
      property: "status",
      value: testcase.status,
    });

    this._saveFileData();
  }

  private _saveInteractorSecret({
    id,
    secret,
  }: v.InferOutput<typeof SaveInteractorSecretMessageSchema>) {
    const testcase = this._getTestcase(id);
    if (!testcase) {
      return;
    }

    super._postMessage({
      type: "SET",
      id,
      property: "interactorSecret",
      value: "",
    });

    testcase.interactorSecret.reset();
    testcase.interactorSecret.write(secret, true);

    if (testcase.interactorSecretResolver) {
      testcase.interactorSecretResolver();
      testcase.interactorSecretResolver = undefined;
    }

    this._saveFileData();
  }

  private _setTimeLimit({ limit }: v.InferOutput<typeof SetTimeLimitSchema>) {
    this._timeLimit = limit;
    this._saveFileData();
  }

  private _setMemoryLimit({ limit }: v.InferOutput<typeof SetMemoryLimitSchema>) {
    this._memoryLimit = limit;
    this._saveFileData();
  }

  private _getTestcase(id: number): State | undefined {
    return this._state.find((t) => t.id === id);
  }
}
