import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

export class ReadonlyTerminal implements vscode.Pseudoterminal {
  private _writeEmitter: vscode.EventEmitter<string> =
    new vscode.EventEmitter();
  private _closeEmitter: vscode.EventEmitter<number> =
    new vscode.EventEmitter();

  onDidWrite: vscode.Event<string> = this._writeEmitter.event;
  onDidClose: vscode.Event<number> = this._closeEmitter.event;

  open(): void {}

  write(text: string): void {
    // VSCode requires \r\n for newline, but keep existing \r\n
    this._writeEmitter.fire(text.replace(/\n/g, "\r\n"));
  }

  close(): void {
    this._closeEmitter.fire(0);
  }
}

// keeps 2 versions of input:
// 1. "condensed" version which all of 2 or more consecutive whitespaces are removed
// 2. "shortened" version which respects the specified maximum boundaries from the settings (not condensed like above)
export class TextHandler {
  private static readonly INTERVAL: number = 30;
  // biome-ignore lint/style/noNonNullAssertion: Default is enforced by VSCode
  private static _maxDisplayCharacters: number = vscode.workspace
    .getConfiguration("fastolympiccoding")
    .get("maxDisplayCharacters")!;
  // biome-ignore lint/style/noNonNullAssertion: Default is enforced by VSCode
  private static _maxDisplayLines: number = vscode.workspace
    .getConfiguration("fastolympiccoding")
    .get("maxDisplayLines")!;
  private _data = "";
  private _shortDataLength = 0;
  private _pending = "";
  private _spacesCount = 0;
  private _newlineCount = 0;
  private _lastWrite = Number.NEGATIVE_INFINITY;
  private _callback: ((data: string) => void) | undefined = undefined;

  get data() {
    return this._data;
  }

  set callback(callback: (data: string) => void) {
    this._callback = callback;
  }

  write(_data: string, last: boolean) {
    const data = _data.replace(/\r\n/g, "\n"); // just avoid \r\n entirely

    // Competitive Companion removes trailing spaces for every line
    for (let i = 0; i < data.length; i++) {
      if (data[i] === " ") {
        this._spacesCount++;
      } else if (data[i] === "\n") {
        this._data += "\n";
        this._spacesCount = 0;
      } else {
        this._data += " ".repeat(this._spacesCount);
        this._data += data[i];
        this._spacesCount = 0;
      }
    }
    if (last && this._data.at(-1) !== "\n") {
      this._data += "\n";
    }
    if (this._shortDataLength > TextHandler._maxDisplayCharacters) {
      return;
    }

    for (
      let i = 0;
      i < data.length &&
      this._shortDataLength < TextHandler._maxDisplayCharacters &&
      this._newlineCount < TextHandler._maxDisplayLines;
      i++
    ) {
      if (data[i] === "\n") {
        this._newlineCount++;
      }
      this._shortDataLength++;
      this._pending += data[i];
    }

    const now = Date.now();
    if (now - this._lastWrite < TextHandler.INTERVAL && !last) {
      return;
    }

    this._lastWrite = now;
    if (
      this._shortDataLength === TextHandler._maxDisplayCharacters ||
      this._newlineCount === TextHandler._maxDisplayLines
    ) {
      this._pending += "...";
      this._shortDataLength = TextHandler._maxDisplayCharacters + 1;
    }
    if (this._callback) {
      this._callback(this._pending);
    }
    this._pending = "";
  }

  reset() {
    this._data = "";
    this._shortDataLength = 0;
    this._pending = "";
    this._spacesCount = 0;
    this._newlineCount = 0;
    this._lastWrite = Number.NEGATIVE_INFINITY;
  }
}

export async function getDefaultBuildTaskName() {
  const tasks = await vscode.tasks.fetchTasks();
  for (const task of tasks) {
    if (task.group?.id === vscode.TaskGroup.Build.id && task.group?.isDefault) {
      return task.name;
    }
  }
  return "";
}

export class ReadonlyStringProvider
  implements vscode.TextDocumentContentProvider
{
  static SCHEME = "fastolympiccoding";
  provideTextDocumentContent(uri: vscode.Uri): vscode.ProviderResult<string> {
    return uri.path;
  }
}

export function resolveVariables(
  string: string,
  inContextOfFile?: string,
): string {
  const workspaces = vscode.workspace.workspaceFolders;
  const workspace = vscode.workspace.workspaceFolders?.at(0);
  const activeEditor = inContextOfFile
    ? undefined
    : vscode.window.activeTextEditor;
  const absoluteFilePath = inContextOfFile ?? activeEditor?.document.uri.fsPath;
  const parsedPath = absoluteFilePath
    ? path.parse(absoluteFilePath)
    : undefined;

  let activeWorkspace = workspace;
  let relativeFilePath = absoluteFilePath;
  for (const workspace of workspaces ?? []) {
    if (absoluteFilePath?.includes(workspace.uri.fsPath)) {
      activeWorkspace = workspace;
      relativeFilePath = absoluteFilePath
        ?.replace(workspace.uri.fsPath, "")
        .substring(path.sep.length);
      break;
    }
  }

  // ${getDefaultBuildTaskName} is not supported because it is slow and requires async. Bark if necessary :)

  const vscodeSubstitutions: { [regex: string]: string } = {
    "${userHome}": os.homedir(),
    "${workspaceFolder}": workspace?.uri.fsPath ?? "",
    "${workspaceFolderBasename}": workspace?.name ?? "",
    "${file}": absoluteFilePath ?? "",
    "${fileWorkspaceFolder}": activeWorkspace?.uri.fsPath ?? "",
    "${relativeFile}": relativeFilePath ?? "",
    "${relativeFileDirname}": relativeFilePath
      ? relativeFilePath.substring(0, relativeFilePath.lastIndexOf(path.sep))
      : "",
    "${fileBasename}": parsedPath?.base ?? "",
    "${fileBasenameNoExtension}": parsedPath?.name ?? "",
    "${fileExtname}": parsedPath?.ext ?? "",
    "${fileDirname}": parsedPath?.dir ?? "",
    "${fileDirnameBasename}": parsedPath
      ? parsedPath.dir.substring(parsedPath.dir.lastIndexOf(path.sep) + 1)
      : "",
    "${cwd}": parsedPath?.dir ?? "",
    "${lineNumber}": `${activeEditor?.selection.start.line ? +1 : ""}`,
    "${selectedText}":
      activeEditor?.document.getText(
        new vscode.Range(
          activeEditor.selection.start,
          activeEditor.selection.end,
        ),
      ) ?? "",
    "${execPath}": process.execPath,
    "${pathSeparator}": path.sep,
    "${/}": path.sep,
    "${exeExtname}": os.platform() === "win32" ? ".exe" : "",
  };

  // Replace all regexes with their matches at once
  const vscodeVariableRgex = new RegExp(
    Object.keys(vscodeSubstitutions)
      .map((variable) => `\\${variable}`)
      .join("|"),
    "g",
  );
  const vscodeResolvedString = string.replace(
    vscodeVariableRgex,
    (variable) => vscodeSubstitutions[variable],
  );

  // Resolve ${path:...} last
  const resolved = vscodeResolvedString.replace(
    /\${path:(.*?)}/g,
    (_, group: string) => path.normalize(group),
  );
  return resolved;
}

export function resolveCommand(command: string, inContextOfFile?: string) {
  const args = command.trim().split(" ");
  return args.map((arg) => resolveVariables(arg, inContextOfFile));
}

export async function openInNewEditor(content: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument({ content });
  vscode.window.showTextDocument(document);
}
