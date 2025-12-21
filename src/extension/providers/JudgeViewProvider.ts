import * as vscode from "vscode";
import * as v from "valibot";

import { Status, Stdio } from "../../shared/enums";
import { ProblemSchema, TestSchema, TestcaseSchema } from "../../shared/schemas";
import BaseViewProvider from "./BaseViewProvider";
import { compile, findAvailablePort, Runnable } from "../utils/runtime";
import {
  getLanguageSettings,
  openInNewEditor,
  ReadonlyStringProvider,
  resolveCommand,
  resolveVariables,
  TextHandler,
} from "../utils/vscode";
import { getLogger } from "../utils/logging";
import {
  Action,
  ActionMessageSchema,
  ProviderMessageSchema,
  ProviderMessageType,
  SaveMessageSchema,
  SetMemoryLimitSchema,
  SetTimeLimitSchema,
  StdinMessageSchema,
  ViewMessageSchema,
  type WebviewMessage,
  WebviewMessageType,
} from "../../shared/judge-messages";

type IProblem = v.InferOutput<typeof ProblemSchema>;
type ITest = v.InferOutput<typeof TestSchema>;
type ITestcase = v.InferOutput<typeof TestcaseSchema>;

const FileDataSchema = v.fallback(
  v.object({
    timeLimit: v.fallback(v.number(), 0),
    memoryLimit: v.fallback(v.number(), 0),
    testcases: v.fallback(v.array(v.unknown()), []),
  }),
  { timeLimit: 0, memoryLimit: 0, testcases: [] }
);

interface IFileData {
  timeLimit: number;
  memoryLimit: number;
  testcases: ITestcase[] | unknown;
}
interface IState extends Omit<ITestcase, "stdin" | "stderr" | "stdout" | "acceptedStdout"> {
  stdin: TextHandler;
  stderr: TextHandler;
  stdout: TextHandler;
  acceptedStdout: TextHandler;
  id: number;
  process: Runnable;
}

function setTestcaseStats(state: IState, timeLimit: number) {
  state.elapsed = state.process.elapsed;
  state.memoryBytes = state.process.maxMemoryBytes;
  if (state.process.timedOut) {
    state.elapsed = timeLimit;
    state.status = Status.TL;
  } else if (state.process.memoryLimitExceeded) {
    state.status = Status.ML;
  } else if (state.process.exitCode === null || state.process.exitCode) {
    state.status = Status.RE;
  } else if (state.acceptedStdout.data === "\n") {
    state.status = Status.NA;
  } else if (state.stdout.data === state.acceptedStdout.data) {
    state.status = Status.AC;
  } else {
    state.status = Status.WA;
  }
}

export default class extends BaseViewProvider<typeof ProviderMessageSchema, WebviewMessage> {
  private _state: Map<number, IState> = new Map(); // Map also remembers insertion order :D
  private _timeLimit = 0;
  private _memoryLimit = 0;
  private _newId = 0;
  private _fileCancellation?: vscode.CancellationTokenSource;
  private _activeDebugTestcaseId?: number;

  private async _getExecutionContext(id: number): Promise<
    | {
        token: vscode.CancellationToken;
        file: string;
        testcase: IState;
        languageSettings: NonNullable<ReturnType<typeof getLanguageSettings>>;
      }
    | undefined
  > {
    const token = this._fileCancellation?.token;
    if (!token || token.isCancellationRequested) {
      return;
    }

    const file = this._currentFile;
    if (!file) {
      return;
    }

    const testcase = this._state.get(id);
    if (!testcase) {
      return;
    }

    // stop already-running process
    this._stop(id);
    await testcase.process.promise;

    if (token.isCancellationRequested || testcase.skipped) {
      return;
    }

    const languageSettings = getLanguageSettings(file);
    if (!languageSettings) {
      return;
    }

    return { token, file, testcase, languageSettings };
  }

  private async _compileIfNeeded(
    id: number,
    token: vscode.CancellationToken,
    file: string,
    testcase: IState,
    languageSettings: NonNullable<ReturnType<typeof getLanguageSettings>>
  ): Promise<boolean> {
    if (!languageSettings.compileCommand) {
      return false;
    }

    testcase.status = Status.COMPILING;
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "status",
      value: Status.COMPILING,
    });

    const code = await compile(file, languageSettings.compileCommand, this._context);

    if (!token.isCancellationRequested && code) {
      testcase.status = Status.CE;
      super._postMessage({
        type: WebviewMessageType.SET,
        id,
        property: "status",
        value: Status.CE,
      });
      this._saveFileData();
      return true;
    }

    return token.isCancellationRequested;
  }

  private _clearIOTexts(id: number, testcase: IState) {
    testcase.stderr.reset();
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "stderr",
      value: "",
    });

    testcase.stdout.reset();
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "stdout",
      value: "",
    });

    testcase.status = Status.RUNNING;
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "status",
      value: Status.RUNNING,
    });
  }

  private _launchProcess(params: {
    id: number;
    token: vscode.CancellationToken;
    testcase: IState;
    resolvedArgs: string[];
    cwd?: string;
    timeout?: number;
    memoryLimit?: number;
  }) {
    const { id, token, testcase, resolvedArgs, cwd, timeout, memoryLimit } = params;

    testcase.process.run(resolvedArgs[0], timeout, memoryLimit, cwd, ...resolvedArgs.slice(1));

    const proc = testcase.process.process;
    if (!proc) {
      return;
    }

    // Write stdin once the process is spawned (more reliable than writing immediately).
    proc.once("spawn", () => {
      if (token.isCancellationRequested) {
        return;
      }
      proc.stdin.write(testcase.stdin.data);
    });

    proc.stderr.on("data", (data: string) => testcase.stderr.write(data, false));
    proc.stdout.on("data", (data: string) => testcase.stdout.write(data, false));
    proc.stderr.once("end", () => testcase.stderr.write("", true));
    proc.stdout.once("end", () => testcase.stdout.write("", true));
    proc.once("error", (data: Error) => {
      if (token.isCancellationRequested) {
        return;
      }
      const logger = getLogger("judge");
      logger.error("Process error during testcase execution", {
        testcaseId: id,
        file: this._currentFile,
        error: data.message,
        command: proc.spawnargs,
      });
      testcase.stderr.write(data.message, true);
      testcase.status = Status.RE;
      super._postMessage({
        type: WebviewMessageType.SET,
        id,
        property: "status",
        value: Status.RE,
      });
      this._saveFileData();
    });
    proc.once("close", () => {
      proc.stderr.removeAllListeners("data");
      proc.stdout.removeAllListeners("data");
      if (token.isCancellationRequested) {
        return;
      }
      setTestcaseStats(testcase, this._timeLimit);
      super._postMessage({
        type: WebviewMessageType.SET,
        id,
        property: "status",
        value: testcase.status,
      });
      super._postMessage({
        type: WebviewMessageType.SET,
        id,
        property: "elapsed",
        value: testcase.elapsed,
      });
      super._postMessage({
        type: WebviewMessageType.SET,
        id,
        property: "memoryBytes",
        value: testcase.memoryBytes,
      });

      this._saveFileData();
    });
  }

  onMessage(msg: v.InferOutput<typeof ProviderMessageSchema>) {
    switch (msg.type) {
      case ProviderMessageType.LOADED:
        this.loadCurrentFileData();
        break;
      case ProviderMessageType.NEXT:
        this._nextTestcase();
        break;
      case ProviderMessageType.ACTION:
        this._action(msg);
        break;
      case ProviderMessageType.SAVE:
        this._save(msg);
        break;
      case ProviderMessageType.VIEW:
        this._viewStdio(msg);
        break;
      case ProviderMessageType.STDIN:
        this._stdin(msg);
        break;
      case ProviderMessageType.TL:
        this._setTimeLimit(msg);
        break;
      case ProviderMessageType.ML:
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
    return this._state.size > 0 || this._timeLimit !== 0 || this._memoryLimit !== 0;
  }

  protected override _sendShowMessage(visible: boolean): void {
    super._postMessage({ type: WebviewMessageType.SHOW, visible });
  }

  protected override _switchToNoFile() {
    this._fileCancellation?.cancel();
    this._fileCancellation?.dispose();
    this._fileCancellation = undefined;

    this.stopAll();
    for (const id of this._state.keys()) {
      super._postMessage({ type: WebviewMessageType.DELETE, id });
    }
    this._state.clear();
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
    for (const id of this._state.keys()) {
      super._postMessage({ type: WebviewMessageType.DELETE, id });
    }
    this._state.clear();
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
      this._addTestcase(testcase);
    }

    super._postMessage({
      type: WebviewMessageType.INITIAL_STATE,
      timeLimit: this._timeLimit,
      memoryLimit: this._memoryLimit,
    });
  }

  protected override _rehydrateWebviewFromState() {
    super._postMessage({
      type: WebviewMessageType.INITIAL_STATE,
      timeLimit: this._timeLimit,
      memoryLimit: this._memoryLimit,
    });

    for (const [id, testcase] of this._state.entries()) {
      // Ensure a clean slate for this id in the webview.
      super._postMessage({ type: WebviewMessageType.DELETE, id });
      super._postMessage({ type: WebviewMessageType.NEW, id });

      super._postMessage({
        type: WebviewMessageType.SET,
        id,
        property: "stdin",
        value: testcase.stdin.data,
      });
      super._postMessage({
        type: WebviewMessageType.SET,
        id,
        property: "stderr",
        value: testcase.stderr.data,
      });
      super._postMessage({
        type: WebviewMessageType.SET,
        id,
        property: "stdout",
        value: testcase.stdout.data,
      });
      super._postMessage({
        type: WebviewMessageType.SET,
        id,
        property: "acceptedStdout",
        value: testcase.acceptedStdout.data,
      });
      super._postMessage({
        type: WebviewMessageType.SET,
        id,
        property: "elapsed",
        value: testcase.elapsed,
      });
      super._postMessage({
        type: WebviewMessageType.SET,
        id,
        property: "memoryBytes",
        value: testcase.memoryBytes,
      });
      super._postMessage({
        type: WebviewMessageType.SET,
        id,
        property: "status",
        value: testcase.status,
      });
      super._postMessage({
        type: WebviewMessageType.SET,
        id,
        property: "shown",
        value: testcase.shown,
      });
      super._postMessage({
        type: WebviewMessageType.SET,
        id,
        property: "toggled",
        value: testcase.toggled,
      });
      super._postMessage({
        type: WebviewMessageType.SET,
        id,
        property: "skipped",
        value: testcase.skipped,
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
        status: Status.WA,
        shown: true,
        toggled: false,
        skipped: false,
      })
    );

    const current = this._currentFile ?? vscode.window.activeTextEditor?.document.fileName;
    if (file === current) {
      this.deleteAll();
      this._timeLimit = data.timeLimit;
      this._memoryLimit = data.memoryLimit;
      for (const testcase of testcases) {
        this._addTestcase(testcase);
      }
      this._saveFileData();

      super._postMessage({
        type: WebviewMessageType.INITIAL_STATE,
        timeLimit: data.timeLimit,
        memoryLimit: data.memoryLimit,
      });
    } else {
      const fileData: IFileData = {
        timeLimit: data.timeLimit,
        memoryLimit: data.memoryLimit,
        testcases,
      };
      super.writeStorage(file, fileData);
    }
  }

  addTestcaseToFile(file: string, testcase: ITestcase) {
    // used by stress view

    const current = this._currentFile ?? vscode.window.activeTextEditor?.document.fileName;
    if (file === current) {
      this._addTestcase(testcase);
      this._saveFileData();
    } else {
      const storageData = super.readStorage()[file];
      const parseResult = v.safeParse(FileDataSchema, storageData);
      const fileData = parseResult.success
        ? parseResult.output
        : { timeLimit: 0, memoryLimit: 0, testcases: [] };
      const testcases = fileData.testcases || [];
      testcases.push(testcase);
      const data: IFileData = {
        timeLimit: fileData.timeLimit ?? 0,
        memoryLimit: fileData.memoryLimit ?? 0,
        testcases,
      };
      super.writeStorage(file, data);
    }
  }

  runAll() {
    for (const id of this._state.keys()) {
      void this._run(id, false);
    }
  }

  debugAll() {
    for (const id of this._state.keys()) {
      void this._debug(id);
    }
  }

  stopAll() {
    for (const id of this._state.keys()) {
      this._stop(id);
    }
  }

  deleteAll() {
    for (const id of this._state.keys()) {
      this._delete(id);
    }
  }

  saveAll() {
    super._postMessage({ type: WebviewMessageType.SAVE_ALL });
  }

  toggleWebviewSettings() {
    super._postMessage({ type: WebviewMessageType.SETTINGS_TOGGLE });
  }

  private _nextTestcase() {
    void this._run(this._addTestcase(), true);
  }

  private _action({ id, action }: v.InferOutput<typeof ActionMessageSchema>) {
    switch (action) {
      case Action.RUN:
        void this._run(id, false);
        break;
      case Action.DEBUG:
        void this._debug(id);
        break;
      case Action.STOP:
        this._stop(id);
        break;
      case Action.DELETE:
        this._delete(id);
        break;
      case Action.EDIT:
        this._edit(id);
        break;
      case Action.ACCEPT:
        this._accept(id);
        break;
      case Action.DECLINE:
        this._decline(id);
        break;
      case Action.TOGGLE_VISIBILITY:
        this._toggleVisibility(id);
        break;
      case Action.TOGGLE_SKIP:
        this._toggleSkip(id);
        break;
      case Action.COMPARE:
        this._compare(id);
        break;
    }
  }

  private _saveFileData() {
    const file = this._currentFile;
    if (!file) {
      return;
    }
    if (this._state.size === 0 && this._timeLimit === 0 && this._memoryLimit === 0) {
      // everything is defaulted, might as well not save it
      super.writeStorage(file, undefined);
      return;
    }

    const testcases: ITestcase[] = [];
    for (const testcase of this._state.values()) {
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
      });
    }
    const fileData: IFileData = {
      timeLimit: this._timeLimit,
      memoryLimit: this._memoryLimit,
      testcases,
    };
    super.writeStorage(file, fileData);
  }

  private _addTestcase(testcase?: Partial<ITestcase>) {
    this._state.set(this._newId, this._createTestcaseState(this._newId, testcase));
    return this._newId++;
  }

  private _createTestcaseState(id: number, testcase?: Partial<ITestcase>) {
    // using partial type to have backward compatibility with old testcases
    // create a new testcase in webview and fill it in later
    super._postMessage({ type: WebviewMessageType.NEW, id });

    const newTestcase: IState = {
      stdin: new TextHandler(),
      stderr: new TextHandler(),
      stdout: new TextHandler(),
      acceptedStdout: new TextHandler(),
      elapsed: testcase?.elapsed ?? 0,
      memoryBytes: testcase?.memoryBytes ?? 0,
      status: testcase?.status ?? Status.NA,
      shown: testcase?.shown ?? true,
      toggled: testcase?.toggled ?? false,
      skipped: testcase?.skipped ?? false,
      id,
      process: new Runnable(),
    };

    newTestcase.stdin.callback = (data: string) =>
      super._postMessage({
        type: WebviewMessageType.STDIO,
        id,
        stdio: Stdio.STDIN,
        data,
      });
    newTestcase.stderr.callback = (data: string) =>
      super._postMessage({
        type: WebviewMessageType.STDIO,
        id,
        stdio: Stdio.STDERR,
        data,
      });
    newTestcase.stdout.callback = (data: string) =>
      super._postMessage({
        type: WebviewMessageType.STDIO,
        id,
        stdio: Stdio.STDOUT,
        data,
      });
    newTestcase.acceptedStdout.callback = (data: string) =>
      super._postMessage({
        type: WebviewMessageType.STDIO,
        id,
        stdio: Stdio.ACCEPTED_STDOUT,
        data,
      });

    newTestcase.stdin.write(testcase?.stdin ?? "", !!testcase);
    newTestcase.stderr.write(testcase?.stderr ?? "", !!testcase);
    newTestcase.stdout.write(testcase?.stdout ?? "", !!testcase);
    newTestcase.acceptedStdout.write(testcase?.acceptedStdout ?? "", true); // force endline for empty answer comparison

    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "status",
      value: newTestcase.status,
    });
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "elapsed",
      value: newTestcase.elapsed,
    });
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "memoryBytes",
      value: newTestcase.memoryBytes,
    });
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "shown",
      value: newTestcase.shown,
    });
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "toggled",
      value: newTestcase.toggled,
    });
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "skipped",
      value: newTestcase.skipped,
    });

    return newTestcase;
  }

  private async _run(id: number, newTestcase: boolean): Promise<void> {
    const ctx = await this._getExecutionContext(id);
    if (!ctx) {
      return;
    }

    const { token, file, testcase, languageSettings } = ctx;

    if (await this._compileIfNeeded(id, token, file, testcase, languageSettings)) {
      return;
    }
    if (token.isCancellationRequested) {
      return;
    }

    this._clearIOTexts(id, testcase);

    const resolvedArgs = resolveCommand(languageSettings.runCommand);
    const cwd = languageSettings.currentWorkingDirectory
      ? resolveVariables(languageSettings.currentWorkingDirectory)
      : undefined;

    this._launchProcess({
      id,
      token,
      testcase,
      resolvedArgs,
      cwd,
      timeout: newTestcase ? undefined : this._timeLimit,
      memoryLimit: newTestcase ? undefined : this._memoryLimit,
    });
  }

  private async _debug(id: number): Promise<void> {
    const ctx = await this._getExecutionContext(id);
    if (!ctx) {
      return;
    }

    const { token, file, testcase, languageSettings } = ctx;

    if (!languageSettings.debugCommand || !languageSettings.debugAttachConfig) {
      const logger = getLogger("judge");
      logger.warn("Debug settings missing for language", {
        file,
        hasDebugCommand: !!languageSettings.debugCommand,
        hasDebugAttachConfig: !!languageSettings.debugAttachConfig,
      });
      vscode.window.showWarningMessage("Missing debug settings for this language.");
      return;
    }

    if (await this._compileIfNeeded(id, token, file, testcase, languageSettings)) {
      return;
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
      logger.error("Failed to allocate debug port", {
        file,
        testcaseId: id,
        error,
      });
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

    this._clearIOTexts(id, testcase);

    // No time limit for debugging; user stops it manually.
    this._launchProcess({
      id,
      token,
      testcase,
      resolvedArgs,
      cwd,
      timeout: undefined,
    });

    // Wait for the debug process to spawn before attaching
    const spawned = await testcase.process.waitForSpawn();
    if (!spawned || token.isCancellationRequested) {
      await testcase.process.promise;
      const exitCode = testcase.process.exitCode;
      const signal = testcase.process.signal;
      const logger = getLogger("judge");
      logger.error("Debug process failed to spawn", {
        file,
        testcaseId: id,
        command: resolvedArgs,
        cwd,
        exitCode,
        signal,
      });
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
    const testcase = this._state.get(id);
    if (!testcase) {
      return;
    }

    // If this testcase is the one currently being debugged, stop the VS Code debug session.
    // This is more reliable than killing the spawned debug-wrapper process alone.
    if (this._activeDebugTestcaseId === id && vscode.debug.activeDebugSession) {
      void vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
    }

    testcase.process.process?.kill();
  }

  private _delete(id: number) {
    this._stop(id);
    super._postMessage({ type: WebviewMessageType.DELETE, id });
    this._state.delete(id);
    this._saveFileData();
  }

  private _edit(id: number) {
    const testcase = this._state.get(id)!;
    testcase.status = Status.EDITING;
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "status",
      value: Status.EDITING,
    });
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "stdin",
      value: testcase.stdin.data,
    });
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "acceptedStdout",
      value: testcase.acceptedStdout.data,
    });
  }

  private _accept(id: number) {
    const testcase = this._state.get(id)!;

    testcase.status = Status.AC;
    // shortened version will be sent back while writing
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "status",
      value: testcase.status,
    });
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "acceptedStdout",
      value: "",
    });
    testcase.acceptedStdout.reset();
    testcase.acceptedStdout.write(testcase.stdout.data, true);

    this._saveFileData();
  }

  private _decline(id: number) {
    const testcase = this._state.get(id)!;

    testcase.status = Status.NA;
    testcase.acceptedStdout.reset();
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "status",
      value: testcase.status,
    });
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "acceptedStdout",
      value: "",
    });
    this._saveFileData();
  }

  private _toggleVisibility(id: number) {
    const testcase = this._state.get(id)!;

    testcase.shown = testcase.toggled ? !testcase.shown : testcase.status === Status.AC;
    testcase.toggled = true;
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "shown",
      value: testcase.shown,
    });
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "toggled",
      value: true,
    });
    this._saveFileData();
  }

  private _toggleSkip(id: number) {
    const testcase = this._state.get(id)!;

    testcase.skipped = !testcase.skipped;
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "skipped",
      value: testcase.skipped,
    });
    this._saveFileData();
  }

  private _compare(id: number) {
    const testcase = this._state.get(id)!;
    const stdout = ReadonlyStringProvider.createUri(`OUTPUT:\n\n${testcase.stdout.data}`);
    const acStdout = ReadonlyStringProvider.createUri(
      `ACCEPTED OUTPUT:\n\n${testcase.acceptedStdout.data}`
    );

    vscode.commands.executeCommand("vscode.diff", stdout, acStdout, `Diff: Testcase #${id + 1}`);
  }

  private _viewStdio({ id, stdio }: v.InferOutput<typeof ViewMessageSchema>) {
    const testcase = this._state.get(id)!;

    switch (stdio) {
      case Stdio.STDIN:
        void openInNewEditor(testcase.stdin.data);
        break;
      case Stdio.STDERR:
        void openInNewEditor(testcase.stderr.data);
        break;
      case Stdio.STDOUT:
        void openInNewEditor(testcase.stdout.data);
        break;
      case Stdio.ACCEPTED_STDOUT:
        void openInNewEditor(testcase.acceptedStdout.data);
        break;
    }
  }

  private _stdin({ id, data }: v.InferOutput<typeof StdinMessageSchema>) {
    const testcase = this._state.get(id)!;
    testcase.process.process?.stdin.write(data);
    testcase.stdin.write(data, false);
  }

  private _save({ id, stdin, acceptedStdout }: v.InferOutput<typeof SaveMessageSchema>) {
    const testcase = this._state.get(id)!;

    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "stdin",
      value: "",
    });
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "acceptedStdout",
      value: "",
    });

    testcase.stdin.reset();
    testcase.acceptedStdout.reset();
    testcase.stdin.write(stdin, true);
    testcase.acceptedStdout.write(acceptedStdout, true);
    setTestcaseStats(testcase, this._timeLimit);

    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "status",
      value: testcase.status,
    });

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
}
