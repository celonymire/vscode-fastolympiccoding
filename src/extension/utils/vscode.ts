import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import * as v from "valibot";

import { LanguageSettingsSchema } from "../../shared/schemas";

export type ILanguageSettings = v.InferOutput<typeof LanguageSettingsSchema>;

export class ReadonlyTerminal implements vscode.Pseudoterminal {
  private _writeEmitter: vscode.EventEmitter<string> = new vscode.EventEmitter();
  private _closeEmitter: vscode.EventEmitter<number> = new vscode.EventEmitter();
  private _readyResolver: (() => void) | undefined = undefined;
  private _ready: Promise<void>;
  private _buffer: string[] = [];
  private _opened = false;

  onDidWrite: vscode.Event<string> = this._writeEmitter.event;
  onDidClose: vscode.Event<number> = this._closeEmitter.event;
  get ready(): Promise<void> {
    return this._ready;
  }

  constructor() {
    this._ready = new Promise<void>((resolve) => {
      this._readyResolver = resolve;
    });
  }

  open(): void {
    this._opened = true;
    this._readyResolver?.();
    this._buffer.forEach((text) => this._writeEmitter.fire(text));
    this._buffer = [];
  }

  write(text: string): void {
    // VSCode requires \r\n for newline, but keep existing \r\n
    const normalized = text.replace(/\n/g, "\r\n");
    if (!this._opened) {
      this._buffer.push(normalized);
      return;
    }
    this._writeEmitter.fire(normalized);
  }

  close(): void {
    this._closeEmitter.fire(0);
  }
}

/**
 * Handles text data with constraints on maximum display characters and lines.
 *
 * The primary purpose of this class is to truncate text for UI display limits,
 * while always preserving the full data internally for any downstream usage,
 * such as answer checking (e.g., comparison with accepted stdout) or other logic
 * that requires the complete, untruncated output.
 *
 * Competitive Companion states the inputs and outputs must end with a newline!
 */
export class TextHandler {
  private static readonly INTERVAL: number = 30;
  private static _maxDisplayCharacters: number = vscode.workspace
    .getConfiguration("fastolympiccoding")
    .get("maxDisplayCharacters")!;
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

  private _appendPendingCharacter(char: string) {
    if (
      this._shortDataLength >= TextHandler._maxDisplayCharacters ||
      this._newlineCount >= TextHandler._maxDisplayLines
    ) {
      return;
    }
    this._pending += char;
    this._shortDataLength++;
    this._newlineCount += char === "\n" ? 1 : 0;
  }

  private _sendPendingIfNeeded(last: boolean) {
    if (this._shortDataLength > TextHandler._maxDisplayCharacters) {
      return;
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
      this._shortDataLength = TextHandler._maxDisplayCharacters + 1; // prevent further appends
    }
    if (this._callback) {
      this._callback(this._pending);
    }
    this._pending = "";
  }

  get data() {
    return this._data;
  }

  set callback(callback: (data: string) => void) {
    this._callback = callback;
  }

  write(_data: string, last: boolean) {
    const data = _data.replace(/\r\n/g, "\n"); // just avoid \r\n entirely

    // Update the "full" version
    for (let i = 0; i < data.length; i++) {
      if (data[i] === " ") {
        this._spacesCount++;
      } else if (data[i] === "\n") {
        this._appendPendingCharacter("\n");
        this._data += "\n";
        this._spacesCount = 0;
      } else {
        for (let j = 0; j < this._spacesCount; j++) {
          this._appendPendingCharacter(" ");
        }
        this._appendPendingCharacter(data[i]);

        this._data += " ".repeat(this._spacesCount);
        this._data += data[i];
        this._spacesCount = 0;
      }
    }

    if (last && this._data.at(-1) !== "\n") {
      this._appendPendingCharacter("\n");
      this._data += "\n";
    }
    this._sendPendingIfNeeded(last);
  }

  reset() {
    // While Competitive Companion requires inputs and outputs to end with a newline,
    // we do not enforce that here to allow appending future data conveniently

    this._data = "";
    this._shortDataLength = 0;
    this._pending = "";
    this._spacesCount = 0;
    this._newlineCount = 0;
    this._lastWrite = Number.NEGATIVE_INFINITY;
  }

  isEmpty() {
    // Consider only newline as empty for Competitive Companion compliance
    return this._data.length === 0 || this._data === "\n";
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

export class ReadonlyStringProvider implements vscode.TextDocumentContentProvider {
  static SCHEME = "fastolympiccoding";
  private static _contents = new Map<string, string>();
  private static _nextId = 0;

  static createUri(content: string): vscode.Uri {
    const id = (this._nextId++).toString();
    this._contents.set(id, content);
    return vscode.Uri.parse(`${this.SCHEME}:/data-${id}`);
  }

  static cleanup(uri: vscode.Uri): void {
    if (uri.scheme === this.SCHEME) {
      const id = uri.path.replace(/^\/data-/, "");
      this._contents.delete(id);
    }
  }

  provideTextDocumentContent(uri: vscode.Uri): vscode.ProviderResult<string> {
    const id = uri.path.replace(/^\/data-/, "");
    return ReadonlyStringProvider._contents.get(id);
  }
}

function resolveStringVariables(
  string: string,
  inContextOfFile?: string,
  extraVariables?: Record<string, string>
): string {
  const workspaces = vscode.workspace.workspaceFolders;
  const workspace = vscode.workspace.workspaceFolders?.at(0);
  const activeEditor = inContextOfFile ? undefined : vscode.window.activeTextEditor;
  const absoluteFilePath = inContextOfFile ?? activeEditor?.document.uri.fsPath;
  const parsedPath = absoluteFilePath ? path.parse(absoluteFilePath) : undefined;

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

  const substitutions: { [regex: string]: string } = {
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
        new vscode.Range(activeEditor.selection.start, activeEditor.selection.end)
      ) ?? "",
    "${execPath}": process.execPath,
    "${pathSeparator}": path.sep,
    "${/}": path.sep,
    "${exeExtname}": os.platform() === "win32" ? ".exe" : "",
  };

  // Merge extraVariables into substitutions
  if (extraVariables) {
    for (const [key, val] of Object.entries(extraVariables)) {
      substitutions[`\${${key}}`] = val;
    }
  }

  // Replace all variables with their values in a single pass
  const variableRegex = new RegExp(
    Object.keys(substitutions)
      .map((variable) => `\\${variable}`)
      .join("|"),
    "g"
  );
  const resolvedString = string.replace(variableRegex, (variable) => substitutions[variable]);

  // Resolve ${path:...} last
  const resolved = resolvedString.replace(/\${path:(.*?)}/g, (_, group: string) =>
    path.normalize(group)
  );
  return resolved;
}

function resolveArrayVariables(
  array: unknown[],
  inContextOfFile?: string,
  extraVariables?: Record<string, string>
): unknown[] {
  return array.map((item) => resolveVariables(item as never, inContextOfFile, extraVariables));
}

function resolveObjectVariables(
  obj: Record<string, unknown>,
  inContextOfFile?: string,
  extraVariables?: Record<string, string>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    result[key] = resolveVariables(val as never, inContextOfFile, extraVariables);
  }
  return result;
}

export function resolveVariables(
  value: string,
  inContextOfFile?: string,
  extraVariables?: Record<string, string>
): string;
export function resolveVariables(
  value: unknown[],
  inContextOfFile?: string,
  extraVariables?: Record<string, string>
): unknown[];
export function resolveVariables(
  value: Record<string, unknown>,
  inContextOfFile?: string,
  extraVariables?: Record<string, string>
): Record<string, unknown>;
export function resolveVariables(
  value: unknown,
  inContextOfFile?: string,
  extraVariables?: Record<string, string>
): unknown {
  if (Array.isArray(value)) {
    return resolveArrayVariables(value, inContextOfFile, extraVariables);
  }
  if (typeof value === "object" && value !== null) {
    return resolveObjectVariables(
      value as Record<string, unknown>,
      inContextOfFile,
      extraVariables
    );
  }
  if (typeof value === "string") {
    return resolveStringVariables(value, inContextOfFile, extraVariables);
  }
  return value;
}

export function resolveCommand(
  command: string,
  inContextOfFile?: string,
  extraVariables?: Record<string, string>
) {
  const args = command.trim().split(" ");
  return args.map((arg) => resolveVariables(arg, inContextOfFile, extraVariables));
}

export async function openInNewEditor(content: string): Promise<void> {
  const uri = ReadonlyStringProvider.createUri(content);
  const document = await vscode.workspace.openTextDocument(uri);
  vscode.window.showTextDocument(document);
}

/**
 * Retrieves and validates language settings for a file extension.
 * Shows a warning if settings are invalid or missing.
 * @returns The validated language settings, or undefined if invalid/missing.
 */
export function getLanguageSettings(file: string): ILanguageSettings | undefined {
  const runSettings = vscode.workspace.getConfiguration("fastolympiccoding.runSettings");
  const extension = path.extname(file);
  const parseResult = v.safeParse(LanguageSettingsSchema, runSettings[extension]);
  if (!parseResult.success) {
    vscode.window.showWarningMessage(
      `Invalid or missing run setting for file extension "${extension}"`
    );
    return undefined;
  }
  return parseResult.output;
}
