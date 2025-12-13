import * as vscode from "vscode";
import * as v from "valibot";

import { Status, Stdio } from "~shared/enums";
import { ProblemSchema, TestSchema, TestcaseSchema } from "~shared/schemas";
import BaseViewProvider from "~extension/providers/BaseViewProvider";
import { compile, Runnable } from "~extension/utils/runtime";
import {
  getLanguageSettings,
  openInNewEditor,
  ReadonlyStringProvider,
  resolveCommand,
  resolveVariables,
  TextHandler,
} from "~extension/utils/vscode";
import {
  Action,
  ActionMessageSchema,
  ProviderMessageSchema,
  ProviderMessageType,
  SaveMessageSchema,
  SetTimeLimitSchema,
  StdinMessageSchema,
  ViewMessageSchema,
  WebviewMessage,
  WebviewMessageType,
} from "~shared/judge-messages";

type IProblem = v.InferOutput<typeof ProblemSchema>;
type ITest = v.InferOutput<typeof TestSchema>;
type ITestcase = v.InferOutput<typeof TestcaseSchema>;

const FileDataSchema = v.partial(
  v.object({
    timeLimit: v.number(),
    testcases: v.array(v.unknown()),
  })
);

interface IFileData {
  timeLimit: number;
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
  if (state.process.timedOut) {
    state.elapsed = timeLimit;
    state.status = Status.TL;
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
  private _newId = 0;
  private _fileCancellation?: vscode.CancellationTokenSource;
  private _onDidChangeActiveTextEditorDisposable?: vscode.Disposable;

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
    }
  }

  onDispose() {
    this._onDidChangeActiveTextEditorDisposable?.dispose();
    this._fileCancellation?.cancel();
    this._fileCancellation?.dispose();
    this.stopAll();
  }

  constructor(context: vscode.ExtensionContext) {
    super("judge", context, ProviderMessageSchema);

    this._onDidChangeActiveTextEditorDisposable = vscode.window.onDidChangeActiveTextEditor(
      () => this.loadCurrentFileData(),
      this
    );
  }

  loadCurrentFileData() {
    // Cancel any in-flight operations for the previous file
    this._fileCancellation?.cancel();
    this._fileCancellation?.dispose();
    this._fileCancellation = new vscode.CancellationTokenSource();

    this.stopAll();
    for (const id of this._state.keys()) {
      super._postMessage({ type: WebviewMessageType.DELETE, id });
    }
    this._timeLimit = 0;
    this._state.clear();

    const file = vscode.window.activeTextEditor?.document.fileName;
    if (!file) {
      super._postMessage({
        type: WebviewMessageType.SHOW,
        visible: false,
      });
      return;
    }
    super._postMessage({ type: WebviewMessageType.SHOW, visible: true });

    const storageData = super.readStorage()[file];
    const parseResult = v.safeParse(FileDataSchema, storageData);
    if (!parseResult.success) {
      // If invalid, use defaults
      this._timeLimit = 0;
      super._postMessage({
        type: WebviewMessageType.INITIAL_STATE,
        timeLimit: this._timeLimit,
      });
      return;
    }
    const fileData = parseResult.output;
    const testcases = fileData.testcases || [];
    const partialSchema = v.partial(TestcaseSchema);
    this._timeLimit = fileData.timeLimit ?? 0;
    for (let i = 0; i < testcases.length; i++) {
      const parseTestcase = v.safeParse(partialSchema, testcases[i]);
      const testcase = parseTestcase.success ? parseTestcase.output : {};
      this._addTestcase(testcase);
    }

    super._postMessage({
      type: WebviewMessageType.INITIAL_STATE,
      timeLimit: this._timeLimit,
    });
  }

  addFromCompetitiveCompanion(file: string, data: IProblem) {
    const testcases: ITestcase[] = data.tests.map(
      (test: ITest): ITestcase => ({
        stdin: test.input,
        stderr: "",
        stdout: "",
        acceptedStdout: test.output,
        elapsed: 0,
        status: Status.WA,
        shown: true,
        toggled: false,
        skipped: false,
      })
    );

    if (file === vscode.window.activeTextEditor?.document.fileName) {
      this.deleteAll();
      this._timeLimit = data.timeLimit;
      for (const testcase of testcases) {
        this._addTestcase(testcase);
      }
      this._saveFileData();

      super._postMessage({
        type: WebviewMessageType.INITIAL_STATE,
        timeLimit: data.timeLimit,
      });
    } else {
      const fileData: IFileData = {
        timeLimit: data.timeLimit,
        testcases,
      };
      super.writeStorage(file, fileData);
    }
  }

  addTestcaseToFile(file: string, testcase: ITestcase) {
    // used by stress view

    if (file === vscode.window.activeTextEditor!.document.fileName) {
      this._addTestcase(testcase);
      this._saveFileData();
    } else {
      const storageData = super.readStorage()[file];
      const parseResult = v.safeParse(FileDataSchema, storageData);
      const fileData = parseResult.success ? parseResult.output : { timeLimit: 0, testcases: [] };
      const testcases = fileData.testcases || [];
      testcases.push(testcase);
      const data: IFileData = {
        timeLimit: fileData.timeLimit ?? 0,
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

  private _nextTestcase() {
    void this._run(this._addTestcase(), true);
  }

  private _action({ id, action }: v.InferOutput<typeof ActionMessageSchema>) {
    switch (action) {
      case Action.RUN:
        void this._run(id, false);
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
    const file = vscode.window.activeTextEditor?.document.fileName;
    if (!file) {
      return;
    }
    if (this._state.size === 0 && this._timeLimit === 0) {
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
        status: testcase.status,
        shown: testcase.shown,
        toggled: testcase.toggled,
        skipped: testcase.skipped,
      });
    }
    const fileData: IFileData = {
      timeLimit: this._timeLimit,
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
    const token = this._fileCancellation?.token;
    if (!token || token.isCancellationRequested) {
      return;
    }

    const file = vscode.window.activeTextEditor?.document.fileName;
    if (!file) {
      return;
    }

    const testcase = this._state.get(id)!;

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

    if (languageSettings.compileCommand) {
      super._postMessage({
        type: WebviewMessageType.SET,
        id,
        property: "status",
        value: Status.COMPILING,
      });
      const code = await compile(file, languageSettings.compileCommand, this._context);

      if (!token.isCancellationRequested && code) {
        super._postMessage({
          type: WebviewMessageType.SET,
          id,
          property: "status",
          value: Status.CE,
        });
        return;
      }
    }

    if (token.isCancellationRequested) {
      return;
    }

    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "stderr",
      value: "",
    });
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "stdout",
      value: "",
    });
    super._postMessage({
      type: WebviewMessageType.SET,
      id,
      property: "status",
      value: Status.RUNNING,
    });

    const resolvedArgs = resolveCommand(languageSettings.runCommand);
    const cwd = languageSettings.currentWorkingDirectory
      ? resolveVariables(languageSettings.currentWorkingDirectory)
      : undefined;
    testcase.stderr.reset();
    testcase.stdout.reset();
    testcase.process.run(
      resolvedArgs[0],
      newTestcase ? undefined : this._timeLimit,
      cwd,
      ...resolvedArgs.slice(1)
    );

    testcase.process.process?.stdin.write(testcase.stdin.data);
    testcase.process.process?.stderr.on("data", (data: string) =>
      testcase.stderr.write(data, false)
    );
    testcase.process.process?.stdout.on("data", (data: string) =>
      testcase.stdout.write(data, false)
    );
    testcase.process.process?.stderr.once("end", () => testcase.stderr.write("", true));
    testcase.process.process?.stdout.once("end", () => testcase.stdout.write("", true));
    testcase.process.process?.once("error", (data: Error) => {
      testcase.stderr.write(data.message, true);
      super._postMessage({
        type: WebviewMessageType.SET,
        id,
        property: "status",
        value: Status.RE,
      });
      this._saveFileData();
    });
    testcase.process.process?.once("close", () => {
      testcase.process.process?.stderr.removeAllListeners("data");
      testcase.process.process?.stdout.removeAllListeners("data");
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

      this._saveFileData();
    });
  }

  private _stop(id: number) {
    this._state.get(id)!.process.process?.kill();
  }

  private _delete(id: number) {
    this._stop(id);
    super._postMessage({ type: WebviewMessageType.DELETE, id });
    this._state.delete(id);
    this._saveFileData();
  }

  private _edit(id: number) {
    const testcase = this._state.get(id)!;
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
    const stdout = vscode.Uri.parse(
      `${ReadonlyStringProvider.SCHEME}:OUTPUT:\n\n${testcase.stdout.data}`
    );
    const acStdout = vscode.Uri.parse(
      `${ReadonlyStringProvider.SCHEME}:ACCEPTED OUTPUT:\n\n${testcase.acceptedStdout.data}`
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
}
