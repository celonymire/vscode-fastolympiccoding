import * as vscode from "vscode";
import * as v from "valibot";
import * as crypto from "crypto";

import {
  TestcaseSchema,
  type LanguageSettings,
  type Mode,
  type TestcaseProperty,
} from "../../shared/schemas";
import BaseViewProvider from "./BaseViewProvider";
import {
  compile,
  findAvailablePort,
  mapTestcaseTermination,
  Runnable,
  severityNumberToInteractiveStatus,
  terminationSeverityNumber,
} from "../utils/runtime";
import type { Severity } from "../utils/runtime";
import {
  getFileRunSettings,
  openInNewEditor,
  openInTerminalTab,
  openOrCreateFile,
  ReadonlyStringProvider,
  resolveVariables,
  showOpenRunSettingsErrorWindow,
  TextHandler,
} from "../utils/vscode";
import { getLogger } from "../utils/logging";
import {
  ActionMessageSchema,
  NewInteractorSecretMessageSchema,
  NextMessageSchema,
  ProviderMessageSchema,
  RequestFullDataMessageSchema,
  RequestTrimmedDataMessageSchema,
  SaveMessageSchema,
  SetMemoryLimitSchema,
  SetTimeLimitSchema,
  StdinMessageSchema,
  ViewMessageSchema,
  type WebviewMessage,
} from "../../shared/judge-messages";
import type { Stdio } from "../../shared/enums";

type Testcase = v.InferOutput<typeof TestcaseSchema>;
type FileData = v.InferOutput<typeof FileDataSchema>;

const FileDataSchema = v.fallback(
  v.object({
    timeLimit: v.fallback(v.number(), 0),
    memoryLimit: v.fallback(v.number(), 0),
    testcases: v.fallback(v.array(TestcaseSchema), []),
  }),
  { timeLimit: 0, memoryLimit: 0, testcases: [] }
);

type State = Omit<
  Testcase,
  "stdin" | "stderr" | "stdout" | "acceptedStdout" | "interactorSecret"
> & {
  stdin: TextHandler;
  stderr: TextHandler;
  stdout: TextHandler;
  acceptedStdout: TextHandler;
  interactorSecret: TextHandler;
  process: Runnable;
  interactorProcess: Runnable;
  interactorSecretResolver?: () => void;
  donePromise: Promise<void> | null;
  cancellationSource?: vscode.CancellationTokenSource;
};

interface RuntimeContext {
  state: State[];
  timeLimit: number;
  memoryLimit: number;
}

type ExecutionContext = {
  token: vscode.CancellationToken;
  testcase: State;
  languageSettings: LanguageSettings;
  interactorArgs: string[] | null;
  cwd?: string;
  file: string;
};

function updateTestcaseFromTermination(state: State) {
  state.elapsed = state.process.elapsed;
  state.memoryBytes = state.process.maxMemoryBytes;
  state.status = mapTestcaseTermination(state.process.termination);
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

function updateInteractiveTestcaseFromTermination(state: State) {
  state.elapsed = state.process.elapsed;
  state.memoryBytes = state.process.maxMemoryBytes;
  state.status = severityNumberToInteractiveStatus(
    Math.max(
      terminationSeverityNumber(state.process.termination) as number,
      terminationSeverityNumber(state.interactorProcess.termination) as number
    ) as Severity
  );
  if (state.status === "WA") {
    // Either judge or interactor returned non-zero error code, so we have 2 cases:
    // 1. Judge returned non-zero, meaning it had a failure
    // 2. Interactor returned non-zero, which indicates wrong answer
    // 3. Interactor return null error code, which indicates failure
    if (state.process.termination === "error" || state.interactorProcess.exitCode === null) {
      state.status = "RE";
    }
  }
}

export default class extends BaseViewProvider<typeof ProviderMessageSchema, WebviewMessage> {
  // Centralized context storage for all files (both active and background)
  private _contexts: Map<string, RuntimeContext> = new Map();

  private _activeDebugTestcaseUuid?: string;

  private _onDidChangeBackgroundTasks = new vscode.EventEmitter<void>();
  readonly onDidChangeBackgroundTasks = this._onDidChangeBackgroundTasks.event;

  // Accessor for the current file's context
  private get _runtime(): RuntimeContext {
    if (!this._currentFile) {
      throw new Error("No current file active");
    }
    const ctx = this._contexts.get(this._currentFile);
    if (!ctx) {
      throw new Error(`Context not initialized for ${this._currentFile}`);
    }
    return ctx;
  }

  // If the testcase is interactive, ensure interactive settings are also valid and resolved
  private async _getExecutionContext(
    uuid: string,
    extraVariables?: Record<string, string>
  ): Promise<ExecutionContext | null> {
    const testcase = this._findTestcase(uuid);
    if (!testcase) {
      return null;
    }

    const token = testcase.cancellationSource?.token;
    if (!token || token.isCancellationRequested || !this._currentFile) {
      return null;
    }

    const settings = getFileRunSettings(this._currentFile, extraVariables);
    if (!settings || (testcase.mode === "interactive" && !settings.interactorFile)) {
      return null;
    }

    // Don't set compiling status to the testcase because if the user exits
    // before the compile is finished, the testcase will be left in a compiling
    // state.
    super._postMessage({
      type: "SET",
      uuid,
      property: "status",
      value: "COMPILING",
    });

    const compilePromises = [];
    const currentFileCompilePromise = compile(this._currentFile!, this._context);
    if (!currentFileCompilePromise) {
      testcase.status = "NA";
      super._postMessage({
        type: "SET",
        uuid,
        property: "status",
        value: "NA",
      });
      return null;
    }
    compilePromises.push(currentFileCompilePromise);
    if (testcase.mode === "interactive") {
      const interactorCompilePromise = compile(settings.interactorFile!, this._context);
      if (!interactorCompilePromise) {
        testcase.status = "NA";
        super._postMessage({
          type: "SET",
          uuid,
          property: "status",
          value: "NA",
        });
        return null;
      }
      compilePromises.push(interactorCompilePromise);
    }
    const results = await Promise.all(compilePromises);
    const compilationError = results.find((r) => r.code !== 0);
    if (compilationError) {
      testcase.status = "CE";
      super._postMessage({
        type: "SET",
        uuid,
        property: "status",
        value: "CE",
      });
      super._postMessage({
        type: "SET",
        uuid,
        property: "stdout",
        value: "",
      });
      super._postMessage({
        type: "SET",
        uuid,
        property: "stderr",
        value: "",
      });
      testcase.stdout.reset();
      testcase.stderr.reset();
      testcase.stdout.write(compilationError.stdout, "final");
      testcase.stderr.write(compilationError.stderr, "final");
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
        showOpenRunSettingsErrorWindow(
          `No run command for ${settings.interactorFile!}`,
          settings.interactorFile!
        );
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
      file: this._currentFile,
    };
  }

  private _prepareRunningState(testcase: State, file: string) {
    testcase.status = "RUNNING";
    super._postMessage(
      {
        type: "SET",
        uuid: testcase.uuid,
        property: "status",
        value: "RUNNING",
      },
      file
    );
    if (testcase.mode === "interactive" || testcase.stdin.isEmpty()) {
      testcase.stdin.reset();
      super._postMessage(
        {
          type: "SET",
          uuid: testcase.uuid,
          property: "stdin",
          value: "",
        },
        file
      );
    }
    if (testcase.mode === "interactive" && testcase.interactorSecret.isEmpty()) {
      testcase.interactorSecret.reset();
      super._postMessage(
        {
          type: "SET",
          uuid: testcase.uuid,
          property: "interactorSecret",
          value: "",
        },
        file
      );
    }
    testcase.stderr.reset();
    super._postMessage(
      {
        type: "SET",
        uuid: testcase.uuid,
        property: "stderr",
        value: "",
      },
      file
    );
    testcase.stdout.reset();
    super._postMessage(
      {
        type: "SET",
        uuid: testcase.uuid,
        property: "stdout",
        value: "",
      },
      file
    );
  }

  private async _launchTestcase(ctx: ExecutionContext, bypassLimits: boolean, debugMode: boolean) {
    const { token, testcase, languageSettings, cwd } = ctx;
    if (!debugMode && !languageSettings.runCommand) {
      const logger = getLogger("judge");
      logger.error(`No run command for ${this._currentFile}`);
      showOpenRunSettingsErrorWindow(`No run command for ${this._currentFile}`, this._currentFile);
      return;
    }
    // we don't need to check debug command and config because they were checked at the caller
    this._prepareRunningState(testcase, ctx.file);

    const runCommand = debugMode ? languageSettings.debugCommand : languageSettings.runCommand;
    if (!runCommand || token.isCancellationRequested) {
      return;
    }

    testcase.process
      .on("spawn", () => {
        testcase.process.stdin?.write(testcase.stdin.data);
      })
      .on("stderr:data", (data: string) => testcase.stderr.write(data, "batch"))
      .on("stdout:data", (data: string) => testcase.stdout.write(data, "batch"))
      .on("stderr:end", () => testcase.stderr.write("", "final"))
      .on("stdout:end", () => testcase.stdout.write("", "final"))
      .on("error", (data: Error) => {
        const logger = getLogger("judge");
        logger.error(`Process error during testcase execution: ${data.message}`);
        testcase.stderr.write(data.message, "final");
        testcase.status = "RE";
        super._postMessage(
          {
            type: "SET",
            uuid: testcase.uuid,
            property: "status",
            value: "RE",
          },
          ctx.file
        );
      })
      .on("close", () => {
        updateTestcaseFromTermination(testcase);
        super._postMessage(
          {
            type: "SET",
            uuid: testcase.uuid,
            property: "status",
            value: testcase.status,
          },
          ctx.file
        );
        super._postMessage(
          {
            type: "SET",
            uuid: testcase.uuid,
            property: "elapsed",
            value: testcase.elapsed,
          },
          ctx.file
        );
        super._postMessage(
          {
            type: "SET",
            uuid: testcase.uuid,
            property: "memoryBytes",
            value: testcase.memoryBytes,
          },
          ctx.file
        );
      })
      .run(
        runCommand,
        bypassLimits ? 0 : this._runtime.timeLimit,
        bypassLimits ? 0 : this._runtime.memoryLimit,
        cwd
      );
    this._onDidChangeBackgroundTasks.fire();

    await testcase.process.done;
    this.requestSave();
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
      showOpenRunSettingsErrorWindow(`No run command for ${this._currentFile}`, this._currentFile);
      return;
    }
    // we don't need to check debug command and config because they were checked at the caller
    this._prepareRunningState(testcase, ctx.file);

    const runCommand = debugMode ? languageSettings.debugCommand : languageSettings.runCommand;
    if (!runCommand || token.isCancellationRequested) {
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
        }
        testcase.interactorProcess.stdin?.write(testcase.interactorSecret.data);
        testcase.interactorSecretResolver?.();
        testcase.interactorSecretResolver = undefined;
      })
      .on("stderr:data", (data: string) => testcase.stderr.write(data, "force"))
      .on("stdout:data", (data: string) => {
        testcase.stdout.write(data, "force");
        testcase.process.stdin?.write(data);
      })
      .on("error", async (data: Error) => {
        const logger = getLogger("judge");
        logger.error(`Process error during testcase execution: ${data.message}`);
        testcase.stderr.write("=== INTERACTOR ERROR ===\n", "batch");
        testcase.stderr.write(data.message, "final");
        testcase.status = "RE";

        await testcase.process.spawned;
        testcase.process.stop();
      });

    testcase.process
      .on("stderr:data", (data: string) => testcase.stderr.write(data, "force"))
      .on("stdout:data", async (data: string) => {
        if (testcase.interactorSecretResolver) {
          await secretPromise;
        }
        testcase.stdout.write(data, "force");
        testcase.interactorProcess.stdin?.write(data);
      })
      .on("error", async (data: Error) => {
        const logger = getLogger("judge");
        logger.error(`Process error during testcase execution: ${data.message}`);
        testcase.stderr.write("=== SOLUTION ERROR ===\n", "batch");
        testcase.stderr.write(data.message, "final");

        await testcase.interactorProcess.spawned;
        testcase.interactorProcess.stop();
      });

    testcase.interactorProcess.run(interactorArgs!, 0, 0, cwd);
    testcase.process.run(
      runCommand,
      bypassLimits ? 0 : this._runtime.timeLimit,
      bypassLimits ? 0 : this._runtime.memoryLimit,
      cwd
    );
    this._onDidChangeBackgroundTasks.fire();

    await Promise.all([testcase.process.done, testcase.interactorProcess.done]);

    testcase.stdin.write("", "final");
    testcase.stderr.write("", "final");
    testcase.stdout.write("", "final");

    updateInteractiveTestcaseFromTermination(testcase);
    super._postMessage(
      {
        type: "SET",
        uuid: testcase.uuid,
        property: "status",
        value: testcase.status,
      },
      ctx.file
    );
    super._postMessage(
      {
        type: "SET",
        uuid: testcase.uuid,
        property: "elapsed",
        value: testcase.elapsed,
      },
      ctx.file
    );
    super._postMessage(
      {
        type: "SET",
        uuid: testcase.uuid,
        property: "memoryBytes",
        value: testcase.memoryBytes,
      },
      ctx.file
    );
    this._onDidChangeBackgroundTasks.fire();
    this.requestSave();
  }

  protected handleMessage(msg: v.InferOutput<typeof ProviderMessageSchema>) {
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
        void this._save(msg);
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
      case "REQUEST_TRIMMED_DATA":
        this._requestTrimmedData(msg);
        break;
      case "REQUEST_FULL_DATA":
        this._requestFullData(msg);
        break;
      case "NEW_INTERACTOR_SECRET":
        this._newInteractorSecret(msg);
        break;
    }
  }

  override onDispose() {
    this.forceSave();

    for (const context of this._contexts.values()) {
      for (const testcase of context.state) {
        testcase.cancellationSource?.cancel();
        testcase.cancellationSource?.dispose();
        testcase.cancellationSource = undefined;
        testcase.process.stop();
        testcase.interactorProcess.stop();
        void testcase.process.dispose();
        void testcase.interactorProcess.dispose();
      }
    }
    this._onDidChangeBackgroundTasks.dispose();

    super.onDispose();
  }

  onShow() {
    this._ensureActiveEditorListener();
    this._syncOrSwitchToTargetFile();
  }

  constructor(context: vscode.ExtensionContext) {
    super("judge", context, ProviderMessageSchema);

    context.subscriptions.push(
      vscode.debug.onDidStartDebugSession((session) => {
        const uuid = session.configuration?.fastolympiccodingTestcaseUuid;
        if (typeof uuid !== "string") {
          return;
        }
        this._activeDebugTestcaseUuid = uuid;
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        const uuid = session.configuration?.fastolympiccodingTestcaseId;
        if (typeof uuid === "string" && this._activeDebugTestcaseUuid === uuid) {
          this._stop(uuid);
          this._activeDebugTestcaseUuid = undefined;
        }
      })
    );

    this.onShow();
  }

  // Judge has state if there are testcases loaded
  protected override _hasState(): boolean {
    return (
      this._runtime.state.length > 0 ||
      this._runtime.timeLimit !== 0 ||
      this._runtime.memoryLimit !== 0
    );
  }

  protected override _sendShowMessage(visible: boolean): void {
    super._postMessage({ type: "SHOW", visible });
  }

  protected override _switchToNoFile() {
    this._moveCurrentStateToBackground();
  }

  private _moveCurrentStateToBackground() {
    this.requestSave();
    if (this._currentFile && this._contexts.has(this._currentFile)) {
      const ctx = this._contexts.get(this._currentFile)!;
      for (const testcase of ctx.state) {
        super._postMessage({ type: "DELETE", uuid: testcase.uuid });
        testcase.donePromise?.then(() => {
          this._onDidChangeBackgroundTasks.fire();
        });
      }
    }

    this._currentFile = undefined;
    this._sendShowMessage(false);
    this._onDidChangeBackgroundTasks.fire();
  }

  private _syncTestcaseState(testcase: State) {
    const uuid = testcase.uuid;

    super._postMessage({ type: "SET", uuid, property: "elapsed", value: testcase.elapsed });
    super._postMessage({ type: "SET", uuid, property: "memoryBytes", value: testcase.memoryBytes });
    super._postMessage({ type: "SET", uuid, property: "status", value: testcase.status });
    super._postMessage({ type: "SET", uuid, property: "shown", value: testcase.shown });
    super._postMessage({ type: "SET", uuid, property: "toggled", value: testcase.toggled });
    super._postMessage({ type: "SET", uuid, property: "skipped", value: testcase.skipped });
    super._postMessage({ type: "SET", uuid, property: "mode", value: testcase.mode });

    const resendTruncatedData = (
      property: "stdin" | "stderr" | "stdout" | "acceptedStdout" | "interactorSecret",
      handler: TextHandler
    ) => {
      const data = handler.data;
      super._postMessage({ type: "SET", uuid, property, value: "" }); // clear out old data
      handler.reset();
      handler.write(data, "final");
    };

    resendTruncatedData("stdin", testcase.stdin);
    resendTruncatedData("stderr", testcase.stderr);
    resendTruncatedData("stdout", testcase.stdout);
    resendTruncatedData("acceptedStdout", testcase.acceptedStdout);
    resendTruncatedData("interactorSecret", testcase.interactorSecret);
  }

  protected override _switchToFile(file: string) {
    this._moveCurrentStateToBackground();

    // Ensure target context exists
    if (!this._contexts.has(file)) {
      // LOAD FROM DISK (simplified for brevity of replacement, assuming unmodified lines follow)
      const storageData = super.readStorage()[file];
      const fileData = v.parse(FileDataSchema, storageData ?? {});
      const timeLimit = fileData.timeLimit;
      const memoryLimit = fileData.memoryLimit;
      const state: State[] = [];

      // Parse testcases
      for (const rawTestcase of fileData.testcases) {
        try {
          const testcase = v.parse(TestcaseSchema, rawTestcase);
          state.push(this._createTestcaseState(testcase.mode, testcase, file));
        } catch (e) {
          console.error("Failed to parse testcase", e);
        }
      }

      this._contexts.set(file, {
        state,
        timeLimit,
        memoryLimit,
      });
    }

    // Switch file
    this._currentFile = file;
    this._sendShowMessage(true);

    // Rehydrate UI
    const ctx = this._runtime;

    super._postMessage({
      type: "INITIAL_STATE",
      timeLimit: ctx.timeLimit,
      memoryLimit: ctx.memoryLimit,
    });

    for (const testcase of ctx.state) {
      super._postMessage({ type: "NEW", uuid: testcase.uuid });
      this._syncTestcaseState(testcase);

      if (testcase.donePromise) {
        void this._awaitTestcaseCompletion(testcase.uuid);
      }
    }
  }

  protected override _rehydrateWebviewFromState() {
    super._postMessage({
      type: "INITIAL_STATE",
      timeLimit: this._runtime.timeLimit,
      memoryLimit: this._runtime.memoryLimit,
    });

    for (const testcase of this._runtime.state) {
      const uuid = testcase.uuid;

      // Ensure a clean slate for this uuid in the webview.
      super._postMessage({ type: "DELETE", uuid });
      super._postMessage({ type: "NEW", uuid });
      this._syncTestcaseState(testcase);
    }
  }

  addTestcaseToFile(file: string, testcase: Testcase, timeLimit?: number, memoryLimit?: number) {
    if (file === this._currentFile) {
      if (timeLimit !== undefined) {
        this._runtime.timeLimit = timeLimit;
      }
      if (memoryLimit !== undefined) {
        this._runtime.memoryLimit = memoryLimit;
      }
      if (timeLimit !== undefined || memoryLimit !== undefined) {
        super._postMessage({
          type: "INITIAL_STATE",
          timeLimit: this._runtime.timeLimit,
          memoryLimit: this._runtime.memoryLimit,
        });
      }

      this._addTestcase(testcase.mode, testcase);
      this.requestSave();
    } else if (this._contexts.has(file)) {
      const ctx = this._contexts.get(file)!;
      if (timeLimit !== undefined) {
        ctx.timeLimit = timeLimit;
      }
      if (memoryLimit !== undefined) {
        ctx.memoryLimit = memoryLimit;
      }
      ctx.state.push(this._createTestcaseState(testcase.mode, testcase, file));
      this.requestSave();
    } else {
      const storageData = super.readStorage()[file];
      const parseResult = v.safeParse(FileDataSchema, storageData);
      const fileData = parseResult.success
        ? parseResult.output
        : { timeLimit: 0, memoryLimit: 0, testcases: [] };

      if (timeLimit !== undefined) {
        fileData.timeLimit = timeLimit;
      }
      if (memoryLimit !== undefined) {
        fileData.memoryLimit = memoryLimit;
      }

      const testcases = fileData.testcases || [];
      testcases.push(testcase);
      const data: FileData = {
        timeLimit: fileData.timeLimit,
        memoryLimit: fileData.memoryLimit,
        testcases,
      };
      void super.writeStorage(file, data);
    }
  }

  runAll() {
    for (const testcase of this._runtime.state) {
      void this._run(testcase.uuid, false);
    }
  }

  debugAll() {
    for (const testcase of this._runtime.state) {
      void this._debug(testcase.uuid);
    }
  }

  stopAll() {
    for (const testcase of this._runtime.state) {
      this._stop(testcase.uuid);
    }
  }

  deleteAll(file?: string) {
    const targetFile = file ?? this._currentFile;
    if (!targetFile) {
      return;
    }

    if (targetFile === this._currentFile) {
      const uuids = [...this._runtime.state.map((testcase) => testcase.uuid)];
      for (const uuid of uuids) {
        this._delete(uuid);
      }
    } else if (this._contexts.has(targetFile)) {
      const ctx = this._contexts.get(targetFile)!;
      for (const testcase of ctx.state) {
        testcase.process.stop();
        testcase.interactorProcess.stop();
        void testcase.process.dispose();
        void testcase.interactorProcess.dispose();
      }
      ctx.state.length = 0;
      this.requestSave();
    } else {
      const storageData = super.readStorage()[targetFile];
      const fileData = v.parse(FileDataSchema, storageData ?? {});
      fileData.testcases.length = 0;
      void super.writeStorage(targetFile, fileData);
    }
  }

  toggleWebviewSettings() {
    super._postMessage({ type: "SETTINGS_TOGGLE" });
  }

  // Background task management
  getBackgroundTasksForFile(file: string): string[] {
    const context = this._contexts.get(file);
    if (!context) {
      return [];
    }
    return context.state.filter((t) => t.donePromise !== null).map((state) => state.uuid);
  }

  getAllBackgroundTasks(): Map<string, string[]> {
    const result = new Map<string, string[]>();
    for (const [file, context] of this._contexts.entries()) {
      const runningTasks = context.state.filter((t) => t.donePromise !== null);
      if (runningTasks.length > 0) {
        result.set(
          file,
          runningTasks.map((state) => state.uuid)
        );
      }
    }
    return result;
  }

  async stopBackgroundTasksForFile(file: string): Promise<void> {
    const context = this._contexts.get(file);
    if (!context) {
      return;
    }

    // Stop all processes
    for (const state of context.state) {
      state.process.stop();
      state.interactorProcess.stop();
    }

    // Wait for all to complete
    const donePromises: Promise<void>[] = [];
    for (const state of context.state) {
      if (state.donePromise) {
        donePromises.push(state.donePromise);
      }
    }
    await Promise.all(donePromises);

    this._onDidChangeBackgroundTasks.fire();
  }

  async stopAllBackgroundTasks(): Promise<void> {
    const files = Array.from(this._contexts.keys());
    await Promise.all(files.map((file) => this.stopBackgroundTasksForFile(file)));
  }

  private _nextTestcase({ mode }: v.InferOutput<typeof NextMessageSchema>) {
    void this._run(this._addTestcase(mode, undefined), true);
  }

  private _action({ uuid, action }: v.InferOutput<typeof ActionMessageSchema>) {
    switch (action) {
      case "RUN":
        void this._run(uuid, false);
        break;
      case "DEBUG":
        void this._debug(uuid);
        break;
      case "STOP":
        this._stop(uuid);
        break;
      case "DELETE":
        this._delete(uuid);
        break;
      case "ACCEPT":
        this._accept(uuid);
        break;
      case "DECLINE":
        this._decline(uuid);
        break;
      case "TOGGLE_VISIBILITY":
        this._toggleVisibility(uuid);
        break;
      case "TOGGLE_SKIP":
        this._toggleSkip(uuid);
        break;
      case "COMPARE":
        this._compare(uuid);
        break;
      case "OPEN_INTERACTOR":
        this._openInteractor();
        break;
      case "TOGGLE_INTERACTIVE":
        this._toggleInteractive(uuid);
        break;
    }
    this.requestSave();
  }

  private _saveTimer: NodeJS.Timeout | undefined;

  private forceSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = undefined;
    }
    this._saveAllState();
  }

  private requestSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
    }
    this._saveTimer = setTimeout(() => {
      this._saveAllState();
      this._saveTimer = undefined;
    }, 200);
  }

  private _saveAllState() {
    const allData = this.readStorage();

    const serialize = (state: State[], timeLimit: number, memoryLimit: number): FileData => {
      const testcases: Testcase[] = state.map((testcase) => ({
        uuid: testcase.uuid,
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
      }));
      return {
        timeLimit,
        memoryLimit,
        testcases,
      };
    };

    // Save all contexts
    for (const [file, context] of this._contexts) {
      allData[file] = serialize(context.state, context.timeLimit, context.memoryLimit);
    }

    // Bulk write to storage
    void this._context.workspaceState.update(this.view, allData);
  }

  private _addTestcase(mode: Mode, testcase?: Partial<Testcase>) {
    const newState = this._createTestcaseState(mode, testcase, this._currentFile!);
    this._runtime.state.push(newState);

    return newState.uuid;
  }

  private _createTestcaseState(mode: Mode, testcase: Partial<Testcase> | undefined, file: string) {
    const uuid = testcase?.uuid ?? crypto.randomUUID();

    // Create a new testcase in webview
    super._postMessage({ type: "NEW", uuid }, file);

    const newTestcase: State = {
      uuid,
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
      process: new Runnable(),
      interactorProcess: new Runnable(),
      interactorSecretResolver: undefined,
      donePromise: null,
    };

    newTestcase.stdin.callback = (data: string) =>
      super._postMessage(
        {
          type: "STDIO",
          uuid,
          stdio: "STDIN",
          data,
        },
        file
      );
    newTestcase.stderr.callback = (data: string) =>
      super._postMessage(
        {
          type: "STDIO",
          uuid,
          stdio: "STDERR",
          data,
        },
        file
      );
    newTestcase.stdout.callback = (data: string) =>
      super._postMessage(
        {
          type: "STDIO",
          uuid,
          stdio: "STDOUT",
          data,
        },
        file
      );
    newTestcase.acceptedStdout.callback = (data: string) =>
      super._postMessage(
        {
          type: "STDIO",
          uuid,
          stdio: "ACCEPTED_STDOUT",
          data,
        },
        file
      );
    newTestcase.interactorSecret.callback = (data: string) =>
      super._postMessage(
        {
          type: "STDIO",
          uuid,
          stdio: "INTERACTOR_SECRET",
          data,
        },
        file
      );

    newTestcase.stdin.write(testcase?.stdin ?? "", testcase ? "final" : "batch");
    newTestcase.stderr.write(testcase?.stderr ?? "", testcase ? "final" : "batch");
    newTestcase.stdout.write(testcase?.stdout ?? "", testcase ? "final" : "batch");
    newTestcase.acceptedStdout.write(testcase?.acceptedStdout ?? "", "final"); // force endline for empty answer comparison
    // We treat interactor secrets as final because there are problems where
    // the solution queries the interactor without reading any input first. The
    // best assumption is to send the complete secret at the start.
    newTestcase.interactorSecret.write(testcase?.interactorSecret ?? "", "final");

    this._syncTestcaseState(newTestcase);

    return newTestcase;
  }

  private async _awaitTestcaseCompletion(uuid: string): Promise<void> {
    const testcase = this._findTestcase(uuid);
    if (!testcase?.donePromise) {
      return;
    }

    await testcase.donePromise;
    testcase.donePromise = null;
    testcase.cancellationSource?.dispose();
    this._onDidChangeBackgroundTasks.fire();
  }

  private async _run(uuid: string, bypassLimits: boolean): Promise<void> {
    const testcase = this._findTestcase(uuid);
    if (!testcase || testcase.skipped) {
      return;
    }

    const donePromise = testcase.donePromise;
    if (donePromise) {
      return;
    }

    testcase.cancellationSource = new vscode.CancellationTokenSource();
    testcase.donePromise = new Promise((resolve) => {
      void (async () => {
        const ctx = await this._getExecutionContext(uuid);
        if (!ctx) {
          resolve();
          return;
        }

        if (ctx.testcase.mode === "interactive") {
          await this._launchInteractiveTestcase(ctx, bypassLimits, false);
        } else {
          await this._launchTestcase(ctx, bypassLimits, false);
        }

        resolve();
      })();
    });

    await this._awaitTestcaseCompletion(uuid);
  }

  private async _debug(uuid: string): Promise<void> {
    const testcase = this._findTestcase(uuid);
    if (!testcase || testcase.skipped) {
      return;
    }

    if (testcase.donePromise) {
      return;
    }

    testcase.cancellationSource = new vscode.CancellationTokenSource();
    testcase.donePromise = new Promise((resolve) => {
      void (async () => {
        let debugPort: number;
        try {
          debugPort = await findAvailablePort();
        } catch (error) {
          const logger = getLogger("judge");
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to allocate debug port because ${errorMessage}`);
          vscode.window.showErrorMessage("Failed to find available port for debugging");
          resolve();
          return;
        }
        const extraVariables: Record<string, string> = { debugPort: String(debugPort) };

        const ctx = await this._getExecutionContext(uuid, extraVariables);
        if (!ctx || !this._currentFile) {
          resolve();
          return;
        }

        if (!ctx.languageSettings.debugCommand) {
          const logger = getLogger("judge");
          logger.error(`No debug command for ${this._currentFile}`);
          showOpenRunSettingsErrorWindow(
            `No debug command for ${this._currentFile}`,
            this._currentFile
          );
          resolve();
          return;
        }
        if (!ctx.languageSettings.debugAttachConfig) {
          const logger = getLogger("judge");
          logger.error(`No debug attach configuration for ${this._currentFile}`);
          showOpenRunSettingsErrorWindow(
            `No debug attach configuration for ${this._currentFile}`,
            this._currentFile
          );
          resolve();
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
            `Debug attach configuration "${ctx.languageSettings.debugAttachConfig}" not found`,
            this._currentFile
          );
          resolve();
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
          const logger = getLogger("judge");
          logger.error(`Debug process failed to spawn`);
          vscode.window.showErrorMessage(`Debug process failed to spawn`);
          resolve();
          return;
        }

        // resolve the values in the attach configuration
        if (ctx.testcase.process.pid) {
          extraVariables.debugPid = String(ctx.testcase.process.pid);
        }
        const resolvedConfig = resolveVariables(
          attachConfig,
          this._currentFile,
          extraVariables
        ) as vscode.DebugConfiguration;

        // Tag this debug session so we can identify which testcase is being debugged.
        // VS Code preserves custom fields on session.configuration.
        resolvedConfig.fastolympiccodingTestcaseUuid = uuid;

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
          this._stop(uuid);
        }

        await Promise.all([testcase.process.done, testcase.interactorProcess.done]);
        resolve();
      })();
    });

    await this._awaitTestcaseCompletion(uuid);
  }

  private _stop(uuid: string) {
    const testcase = this._findTestcase(uuid);
    if (!testcase) {
      return;
    }

    // If this testcase is the one currently being debugged, stop the VS Code debug session.
    // This is more reliable than killing the spawned debug-wrapper process alone.
    if (this._activeDebugTestcaseUuid === uuid && vscode.debug.activeDebugSession) {
      void vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
    }

    testcase.process.stop();
    testcase.interactorProcess.stop();
  }

  private _delete(uuid: string) {
    this._stop(uuid);
    super._postMessage({ type: "DELETE", uuid });
    const idx = this._runtime.state.findIndex((t) => t.uuid === uuid);
    if (idx !== -1) {
      const state = this._runtime.state[idx];
      state.process.dispose();
      state.interactorProcess.dispose();
      this._runtime.state.splice(idx, 1);
    }
  }

  private _accept(uuid: string) {
    const testcase = this._findTestcase(uuid);
    if (!testcase) {
      return;
    }

    testcase.status = "AC";
    // shortened version will be sent back while writing
    super._postMessage({
      type: "SET",
      uuid,
      property: "status",
      value: testcase.status,
    });
    super._postMessage({
      type: "SET",
      uuid,
      property: "acceptedStdout",
      value: "",
    });
    testcase.acceptedStdout.reset();
    testcase.acceptedStdout.write(testcase.stdout.data, "final");
  }

  private _decline(uuid: string) {
    const testcase = this._findTestcase(uuid);
    if (!testcase) {
      return;
    }

    testcase.status = "NA";
    testcase.acceptedStdout.reset();
    super._postMessage({
      type: "SET",
      uuid,
      property: "status",
      value: testcase.status,
    });
    super._postMessage({
      type: "SET",
      uuid,
      property: "acceptedStdout",
      value: "",
    });
  }

  private _toggleVisibility(uuid: string) {
    const testcase = this._findTestcase(uuid);
    if (!testcase) {
      return;
    }

    testcase.shown = testcase.toggled ? !testcase.shown : testcase.status === "AC";
    testcase.toggled = true;
    super._postMessage({
      type: "SET",
      uuid,
      property: "shown",
      value: testcase.shown,
    });
    super._postMessage({
      type: "SET",
      uuid,
      property: "toggled",
      value: true,
    });
  }

  private _toggleSkip(uuid: string) {
    const testcase = this._findTestcase(uuid);
    if (!testcase) {
      return;
    }

    testcase.skipped = !testcase.skipped;
    super._postMessage({
      type: "SET",
      uuid,
      property: "skipped",
      value: testcase.skipped,
    });
    if (testcase.skipped && !testcase.toggled) {
      testcase.shown = false;
      super._postMessage({
        type: "SET",
        uuid,
        property: "shown",
        value: false,
      });
    } else if (!testcase.skipped && !testcase.toggled) {
      testcase.shown = testcase.status !== "AC";
      super._postMessage({
        type: "SET",
        uuid,
        property: "shown",
        value: testcase.shown,
      });
    }
  }

  private _toggleInteractive(uuid: string) {
    const testcase = this._findTestcase(uuid);
    if (!testcase) {
      return;
    }

    testcase.mode = testcase.mode === "interactive" ? "standard" : "interactive";
    super._postMessage({
      type: "SET",
      uuid,
      property: "mode",
      value: testcase.mode,
    });
  }

  private _compare(uuid: string) {
    const testcase = this._findTestcase(uuid);
    if (!testcase) {
      return;
    }
    const stdout = ReadonlyStringProvider.createUri(`OUTPUT:\n\n${testcase.stdout.data}`);
    const acStdout = ReadonlyStringProvider.createUri(
      `ACCEPTED OUTPUT:\n\n${testcase.acceptedStdout.data}`
    );

    vscode.commands.executeCommand("vscode.diff", stdout, acStdout, `Diff: Testcase ${uuid}`);
  }

  private _viewStdio({ uuid, stdio }: v.InferOutput<typeof ViewMessageSchema>) {
    const testcase = this._findTestcase(uuid);
    if (!testcase) {
      return;
    }

    switch (stdio) {
      case "STDIN":
        void openInNewEditor(testcase.stdin.data);
        break;
      case "STDERR":
        if (testcase.status === "CE") {
          void openInTerminalTab(testcase.stderr.data, "Compilation Error");
        } else {
          void openInNewEditor(testcase.stderr.data);
        }
        break;
      case "STDOUT":
        if (testcase.status === "CE") {
          void openInTerminalTab(testcase.stdout.data, "Compilation Output");
        } else {
          void openInNewEditor(testcase.stdout.data);
        }
        break;
      case "ACCEPTED_STDOUT":
        void openInNewEditor(testcase.acceptedStdout.data);
        break;
      case "INTERACTOR_SECRET":
        void openInNewEditor(testcase.interactorSecret.data);
        break;
    }
  }

  private _openInteractor() {
    if (!this._currentFile) {
      return;
    }
    const settings = getFileRunSettings(this._currentFile);
    if (!settings) {
      return;
    }

    if (settings.interactorFile) {
      void openOrCreateFile(settings.interactorFile);
    } else {
      void vscode.window.showWarningMessage("Interactor file not specified");
    }
  }

  private _stdin({ uuid, data }: v.InferOutput<typeof StdinMessageSchema>) {
    const testcase = this._findTestcase(uuid);
    if (!testcase) {
      return;
    }

    if (testcase.mode === "interactive") {
      testcase.interactorProcess.stdin?.write(data);
      testcase.stdout.write(data, "force");
    } else {
      testcase.process.stdin?.write(data);
      testcase.stdin.write(data, "force");
    }
  }

  private _save({ uuid, stdio, data }: v.InferOutput<typeof SaveMessageSchema>) {
    const testcase = this._findTestcase(uuid);
    if (!testcase) {
      return;
    }

    // Clear the webview's edit field
    const propertyMap: Record<Stdio, TestcaseProperty | null> = {
      STDIN: "stdin",
      ACCEPTED_STDOUT: "acceptedStdout",
      INTERACTOR_SECRET: "interactorSecret",
      STDERR: null,
      STDOUT: null,
    };
    const property = propertyMap[stdio];
    if (property) {
      super._postMessage({
        type: "SET",
        uuid,
        property,
        value: "",
      });
    }

    // Update the appropriate stdio handler and field
    switch (stdio) {
      case "STDIN":
        testcase.stdin.reset();
        // We don't append newline if stdin is empty because online inputs in the future
        // will get affected by the newline
        testcase.stdin.write(data, data === "" ? "force" : "final");
        break;
      case "ACCEPTED_STDOUT":
        testcase.acceptedStdout.reset();
        testcase.acceptedStdout.write(data, "final");
        break;
      case "INTERACTOR_SECRET":
        testcase.interactorSecret.reset();
        testcase.interactorSecret.write(data, "final");
        break;
      case "STDERR":
      case "STDOUT":
        // Read-only fields, ignore
        break;
    }

    if (testcase.mode === "interactive") {
      updateInteractiveTestcaseFromTermination(testcase);
    } else {
      updateTestcaseFromTermination(testcase);
    }
    super._postMessage({
      type: "SET",
      uuid,
      property: "status",
      value: testcase.status,
    });

    this.requestSave();
  }

  private _setTimeLimit({ limit }: v.InferOutput<typeof SetTimeLimitSchema>) {
    this._runtime.timeLimit = limit;
    this.requestSave();
  }

  private _setMemoryLimit({ limit }: v.InferOutput<typeof SetMemoryLimitSchema>) {
    this._runtime.memoryLimit = limit;
    this.requestSave();
  }

  private _requestTrimmedData({
    uuid,
    stdio,
  }: v.InferOutput<typeof RequestTrimmedDataMessageSchema>) {
    const testcase = this._findTestcase(uuid);
    if (!testcase) {
      return;
    }

    const sendProperty = (property: TestcaseProperty, handler: TextHandler) => {
      // clear out webview content first
      super._postMessage({
        type: "SET",
        uuid,
        property,
        value: "",
      });

      // send back the data and let the text handler trim it
      const data = handler.data;
      handler.reset();
      handler.write(data, "final");
    };

    // Only some of these values will be used in practice but do this for sake of handling them
    switch (stdio) {
      case "STDIN":
        sendProperty("stdin", testcase.stdin);
        break;
      case "STDERR":
        sendProperty("stderr", testcase.stderr);
        break;
      case "STDOUT":
        sendProperty("stdout", testcase.stdout);
        break;
      case "ACCEPTED_STDOUT":
        sendProperty("acceptedStdout", testcase.acceptedStdout);
        break;
      case "INTERACTOR_SECRET":
        sendProperty("interactorSecret", testcase.interactorSecret);
        break;
    }
  }

  private _requestFullData({ uuid, stdio }: v.InferOutput<typeof RequestFullDataMessageSchema>) {
    const testcase = this._findTestcase(uuid);
    if (!testcase) {
      return;
    }

    // Only some of these values will be used in practice but do this for sake of handling them
    let property: TestcaseProperty;
    let value: string;
    switch (stdio) {
      case "STDIN":
        property = "stdin";
        value = testcase.stdin.data;
        break;
      case "STDERR":
        property = "stderr";
        value = testcase.stderr.data;
        break;
      case "STDOUT":
        property = "stdout";
        value = testcase.stdout.data;
        break;
      case "ACCEPTED_STDOUT":
        property = "acceptedStdout";
        value = testcase.acceptedStdout.data;
        break;
      case "INTERACTOR_SECRET":
        property = "interactorSecret";
        value = testcase.interactorSecret.data;
        break;
    }

    super._postMessage({
      type: "SET",
      uuid,
      property,
      value: value.trimEnd(),
    });
  }

  private _newInteractorSecret(msg: v.InferOutput<typeof NewInteractorSecretMessageSchema>) {
    const testcase = this._findTestcase(msg.uuid);
    if (!testcase) {
      return;
    }
    testcase.interactorSecret.reset();
    testcase.interactorSecret.write(msg.data, "final");
    testcase.interactorSecretResolver?.();
    testcase.interactorSecretResolver = undefined;
  }

  private _findTestcase(uuid: string): State | undefined {
    return this._runtime.state.find((t) => t.uuid === uuid);
  }
}
