import * as vscode from "vscode";
import * as v from "valibot";

import {
  ProblemSchema,
  TestSchema,
  TestcaseSchema,
  type LanguageSettings,
  type Mode,
} from "../../shared/schemas";
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
  getFileRunSettings,
  openInNewEditor,
  ReadonlyStringProvider,
  resolveVariables,
  showOpenRunSettingsErrorWindow,
  TextHandler,
} from "../utils/vscode";
import { getLogger } from "../utils/logging";
import {
  ActionMessageSchema,
  NextMessageSchema,
  ProviderMessageSchema,
  RequestDataMessageSchema,
  SaveMessageSchema,
  SetMemoryLimitSchema,
  SetTimeLimitSchema,
  StdinMessageSchema,
  ViewMessageSchema,
  type WebviewMessage,
} from "../../shared/judge-messages";
import type { Stdio } from "../../shared/enums";

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

type ExecutionContext = {
  token: vscode.CancellationToken;
  testcase: State;
  languageSettings: LanguageSettings;
  interactorArgs: string[] | null;
  cwd?: string;
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
  if (state.status === "WA") {
    // Either judge or interactor returned non-zero error code, so we have 2 cases:
    // 1. Judge returned non-zero, meaning it crashed
    // 2. Interactor returned non-zero, which indicates wrong answer
    if (termination === "error") {
      state.status = "RE";
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

  // If the testcase is interactive, ensure interactive settings are also valid and resolved
  private async _getExecutionContext(
    id: number,
    extraVariables?: Record<string, string>
  ): Promise<ExecutionContext | null> {
    const token = this._fileCancellation?.token;
    if (!token || token.isCancellationRequested || !this._currentFile) {
      return null;
    }

    const testcase = this._getTestcase(id);
    if (!testcase) {
      return null;
    }

    // stop already-running process
    this._stop(id);
    await testcase.process.done;
    if (testcase.skipped) {
      return null;
    }

    const settings = getFileRunSettings(this._currentFile, extraVariables);
    if (!settings) {
      return null;
    }

    const compilePromises = [this._compileIfNeeded(id, token, this._currentFile, testcase)];
    if (testcase.mode === "interactive") {
      if (!settings.interactorFile) {
        const logger = getLogger("judge");
        logger.error(`No interactor file specified in run settings`);
        showOpenRunSettingsErrorWindow(`No interactor file specified in run settings`);
        return null;
      }

      compilePromises.push(this._compileIfNeeded(id, token, settings.interactorFile, testcase));
    }
    const errored = await Promise.all(compilePromises);
    const anyErrored = errored.some((hadError) => hadError);
    if (anyErrored) {
      return null;
    }

    let interactorArgs: string[] | null = null;
    if (testcase.mode === "interactive") {
      const interactorSettings = getFileRunSettings(settings.interactorFile!);
      if (!interactorSettings) {
        return null;
      }
      const interactorRunCommand = interactorSettings.languageSettings.runCommand;
      if (!interactorRunCommand) {
        const logger = getLogger("judge");
        logger.error(`No run command for ${settings.interactorFile!}`);
        showOpenRunSettingsErrorWindow(`No run command for ${settings.interactorFile!}`);
        return null;
      }
      interactorArgs = interactorRunCommand;
    }

    if (token.isCancellationRequested) {
      return null;
    }

    return {
      token,
      testcase,
      languageSettings: settings.languageSettings,
      interactorArgs,
      cwd: settings.languageSettings.currentWorkingDirectory,
    };
  }

  private async _compileIfNeeded(
    id: number,
    token: vscode.CancellationToken,
    file: string,
    testcase: State
  ): Promise<boolean> {
    const compilePromise = compile(file, this._context);
    if (!compilePromise) {
      return false;
    }

    testcase.status = "COMPILING";
    super._postMessage({
      type: "SET",
      id,
      property: "status",
      value: "COMPILING",
    });

    if (!token.isCancellationRequested && (await compilePromise)) {
      testcase.status = "CE";
      super._postMessage({
        type: "SET",
        id,
        property: "status",
        value: "CE",
      });
      this._saveFileData();
      return true;
    } else {
      testcase.status = "NA";
      super._postMessage({
        type: "SET",
        id,
        property: "status",
        value: "NA",
      });
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

  private _launchTestcase(ctx: ExecutionContext, bypassLimits: boolean, debugMode: boolean) {
    const { token, testcase, languageSettings, cwd } = ctx;
    if (!debugMode && !languageSettings.runCommand) {
      const logger = getLogger("judge");
      logger.error(`No run command for ${this._currentFile}`);
      showOpenRunSettingsErrorWindow(`No run command for ${this._currentFile}`);
      return;
    }
    // we don't need to check debug command and config because they were checked at the caller
    this._prepareRunningState(testcase.id, testcase);

    const runCommand = debugMode ? languageSettings.debugCommand : languageSettings.runCommand;
    if (!runCommand) {
      return;
    }

    testcase.process.run(
      runCommand,
      bypassLimits ? 0 : this._timeLimit,
      bypassLimits ? 0 : this._memoryLimit,
      cwd
    );

    const proc = testcase.process.process;
    if (!proc) {
      return;
    }

    testcase.process
      .on("spawn", () => {
        if (token.isCancellationRequested) {
          return;
        }
        proc.stdin.write(testcase.stdin.data);
      })
      .on("stderr:data", (data: string) => testcase.stderr.write(data, "batch"))
      .on("stdout:data", (data: string) => testcase.stdout.write(data, "batch"))
      .on("stderr:end", () => testcase.stderr.write("", "final"))
      .on("stdout:end", () => testcase.stdout.write("", "final"))
      .on("error", (data: Error) => {
        if (token.isCancellationRequested) {
          return;
        }
        const logger = getLogger("judge");
        logger.error(`Process error during testcase execution: ${data.message}`);
        testcase.stderr.write(data.message, "final");
        testcase.status = "RE";
        super._postMessage({
          type: "SET",
          id: testcase.id,
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
          id: testcase.id,
          property: "status",
          value: testcase.status,
        });
        super._postMessage({
          type: "SET",
          id: testcase.id,
          property: "elapsed",
          value: testcase.elapsed,
        });
        super._postMessage({
          type: "SET",
          id: testcase.id,
          property: "memoryBytes",
          value: testcase.memoryBytes,
        });

        this._saveFileData();
      });
  }

  private async _launchInteractiveTestcase(
    ctx: ExecutionContext,
    bypassLimits: boolean,
    debugMode: boolean
  ) {
    const { token, testcase, languageSettings, interactorArgs, cwd } = ctx;
    if (!debugMode && !languageSettings.runCommand) {
      const logger = getLogger("judge");
      logger.error(`No run command for ${this._currentFile}`);
      showOpenRunSettingsErrorWindow(`No run command for ${this._currentFile}`);
      return;
    }
    // we don't need to check debug command and config because they were checked at the caller
    this._prepareRunningState(testcase.id, testcase);

    const runCommand = debugMode ? languageSettings.debugCommand : languageSettings.runCommand;
    if (!runCommand) {
      return;
    }

    testcase.process.run(
      runCommand,
      bypassLimits ? 0 : this._timeLimit,
      bypassLimits ? 0 : this._memoryLimit,
      cwd
    );
    // Don't restrict the interactor's time and memory limit
    testcase.interactorProcess.run(interactorArgs!, 0, 0, cwd);

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
      .on("stderr:data", (data: string) => testcase.stderr.write(data, "force"))
      .on("stdout:data", (data: string) => {
        testcase.stdin.write(data, "force");
        proc.stdin.write(data);
      })
      .on("error", (data: Error) => {
        if (token.isCancellationRequested) {
          return;
        }
        const logger = getLogger("judge");
        logger.error(`Process error during testcase execution: ${data.message}`);
        testcase.stderr.write("=== INTERACTOR ERROR ===\n", "batch");
        testcase.stderr.write(data.message, "final");
        testcase.status = "RE";

        testcase.process.process?.kill();
      })
      .on("close", () => {
        testcase.process.process?.stdin.end();
      });

    testcase.process
      .on("stderr:data", (data: string) => testcase.stderr.write(data, "force"))
      .on("stdout:data", async (data: string) => {
        if (testcase.interactorSecretResolver) {
          await secretPromise;
        }
        testcase.stdout.write(data, "force");
        interactorProc.stdin.write(data);
      })
      .on("error", (data: Error) => {
        if (token.isCancellationRequested) {
          return;
        }
        const logger = getLogger("judge");
        logger.error(`Process error during testcase execution: ${data.message}`);
        testcase.stderr.write("=== SOLUTION ERROR ===\n", "batch");
        testcase.stderr.write(data.message, "final");

        testcase.interactorProcess.process?.kill();
      })
      .on("close", () => {
        testcase.interactorProcess.process?.stdin.end();
      });

    const [termination, interactorTermination] = await Promise.all([
      testcase.process.done,
      testcase.interactorProcess.done,
    ]);

    testcase.stdin.write("", "final");
    testcase.stderr.write("", "final");
    testcase.stdout.write("", "final");

    updateInteractiveTestcaseFromTermination(testcase, termination, interactorTermination);
    super._postMessage({
      type: "SET",
      id: testcase.id,
      property: "status",
      value: testcase.status,
    });
    super._postMessage({
      type: "SET",
      id: testcase.id,
      property: "elapsed",
      value: testcase.elapsed,
    });
    super._postMessage({
      type: "SET",
      id: testcase.id,
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
      case "REQUEST_DATA":
        this._requestData(msg);
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
    const fileData = v.parse(FileDataSchema, storageData ?? {});
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
      this._addTestcase(testcase.mode, testcase);
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
    const ids = [...this._state.map((testcase) => testcase.id)];
    for (const id of ids) {
      this._delete(id);
    }
  }

  saveAll() {
    super._postMessage({ type: "SAVE_ALL" });
  }

  toggleWebviewSettings() {
    super._postMessage({ type: "SETTINGS_TOGGLE" });
  }

  private _nextTestcase({ mode }: v.InferOutput<typeof NextMessageSchema>) {
    void this._run(this._addTestcase(mode, undefined), true);
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

    newTestcase.stdin.write(testcase?.stdin ?? "", testcase ? "final" : "batch");
    newTestcase.stderr.write(testcase?.stderr ?? "", testcase ? "final" : "batch");
    newTestcase.stdout.write(testcase?.stdout ?? "", testcase ? "final" : "batch");
    newTestcase.acceptedStdout.write(testcase?.acceptedStdout ?? "", "final"); // force endline for empty answer comparison
    // We treat interactor secrets as final because there are problems where
    // the solution queries the interactor without reading any input first. The
    // best assumption is to send the complete secret at the start.
    newTestcase.interactorSecret.write(testcase?.interactorSecret ?? "", "final");

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

    if (ctx.testcase.mode === "interactive") {
      this._launchInteractiveTestcase(ctx, newTestcase, false);
    } else {
      this._launchTestcase(ctx, newTestcase, false);
    }
  }

  private async _debug(id: number): Promise<void> {
    let debugPort: number;
    try {
      debugPort = await findAvailablePort();
    } catch (error) {
      const logger = getLogger("judge");
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to allocate debug port because ${errorMessage}`);
      vscode.window.showErrorMessage("Failed to find available port for debugging");
      return;
    }
    const extraVariables = { debugPort: String(debugPort) };

    const ctx = await this._getExecutionContext(id, extraVariables);
    if (!ctx || !this._currentFile) {
      return;
    }

    if (!ctx.languageSettings.debugCommand) {
      const logger = getLogger("judge");
      logger.error(`No debug command for ${this._currentFile}`);
      showOpenRunSettingsErrorWindow(`No debug command for ${this._currentFile}`);
      return;
    }
    if (!ctx.languageSettings.debugAttachConfig) {
      const logger = getLogger("judge");
      logger.error(`No debug attach configuration for ${this._currentFile}`);
      showOpenRunSettingsErrorWindow(`No debug attach configuration for ${this._currentFile}`);
      return;
    }

    // get the attach debug configuration
    const folder =
      vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this._currentFile)) ??
      vscode.workspace.workspaceFolders?.at(0);
    const attachConfig = vscode.workspace
      .getConfiguration("launch", folder)
      .get<vscode.DebugConfiguration[]>("configurations", [])
      .find((config) => config.name === ctx.languageSettings.debugAttachConfig);
    if (!attachConfig) {
      const logger = getLogger("judge");
      logger.error(
        `Debug attach configuration "${ctx.languageSettings.debugAttachConfig}" not found`
      );
      showOpenRunSettingsErrorWindow(
        `Debug attach configuration "${ctx.languageSettings.debugAttachConfig}" not found`
      );
      return;
    }

    // No limits for debugging testcases
    if (ctx.testcase.mode === "interactive") {
      this._launchInteractiveTestcase(ctx, true, true);
    } else {
      this._launchTestcase(ctx, true, true);
    }

    // Wait for the debug process to spawn before attaching
    const spawnedPromises = [ctx.testcase.process.spawned];
    if (ctx.testcase.mode === "interactive") {
      spawnedPromises.push(ctx.testcase.interactorProcess.spawned);
    }
    const spawned = await Promise.all(spawnedPromises);
    let allSpawned = true;
    for (const spawnedProcess of spawned) {
      if (!spawnedProcess) {
        allSpawned = false;
      }
    }

    if (!allSpawned || ctx.token.isCancellationRequested) {
      await ctx.testcase.process.done;
      await ctx.testcase.interactorProcess.done;
      const logger = getLogger("judge");
      logger.error(`Debug process failed to spawn`);
      vscode.window.showErrorMessage(`Debug process failed to spawn`);
      return;
    }

    // resolve the values in the attach configuration
    const resolvedConfig = resolveVariables(attachConfig, this._currentFile, extraVariables);

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
    testcase.acceptedStdout.write(testcase.stdout.data, "final");

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
      testcase.stdout.write(data, "force");
    } else {
      testcase.process.process?.stdin.write(data);
      testcase.stdin.write(data, "force");
    }
  }

  private _save({ id, stdio, data }: v.InferOutput<typeof SaveMessageSchema>) {
    const testcase = this._getTestcase(id);
    if (!testcase) {
      return;
    }

    console.log("received save message", { id, stdio, data });

    // Clear the webview's edit field
    const propertyMap: Record<Stdio, keyof ITestcase | null> = {
      STDIN: "stdin",
      ACCEPTED_STDOUT: "acceptedStdout",
      INTERACTOR_SECRET: "interactorSecret",
      STDERR: null,
      STDOUT: null,
    };
    const property = propertyMap[stdio];
    if (property) {
      console.log("clearing edit field");
      super._postMessage({
        type: "SET",
        id,
        property,
        value: "",
      });
    }

    // Update the appropriate stdio handler and field
    switch (stdio) {
      case "STDIN":
        testcase.stdin.reset();
        testcase.stdin.write(data, "final");
        console.log("updated stdin", testcase.stdin.data);
        break;
      case "ACCEPTED_STDOUT":
        testcase.acceptedStdout.reset();
        testcase.acceptedStdout.write(data, "final");
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
        break;
      case "INTERACTOR_SECRET":
        testcase.interactorSecret.reset();
        testcase.interactorSecret.write(data, "final");
        if (testcase.interactorSecretResolver) {
          testcase.interactorSecretResolver();
          testcase.interactorSecretResolver = undefined;
        }
        break;
      case "STDERR":
      case "STDOUT":
        // Read-only fields, ignore
        break;
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

  private _requestData({ id, stdio }: v.InferOutput<typeof RequestDataMessageSchema>) {
    const testcase = this._getTestcase(id);
    if (!testcase) {
      return;
    }

    // Only some of these values will be used in practice but do this for sake of handling them
    let data: string;
    switch (stdio) {
      case "STDIN":
        data = testcase.stdin.data;
        break;
      case "STDERR":
        data = testcase.stderr.data;
        break;
      case "STDOUT":
        data = testcase.stdout.data;
        break;
      case "ACCEPTED_STDOUT":
        data = testcase.acceptedStdout.data;
        break;
      case "INTERACTOR_SECRET":
        data = testcase.interactorSecret.data;
        break;
      default:
        data = "";
        break;
    }

    super._postMessage({
      type: "FULL_DATA",
      id,
      stdio,
      data,
    });
  }

  private _getTestcase(id: number): State | undefined {
    return this._state.find((t) => t.id === id);
  }
}
