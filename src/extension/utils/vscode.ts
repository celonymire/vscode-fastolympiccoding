import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import * as v from "valibot";

import { RunSettingsSchema, type LanguageSettings, type RunSettings } from "../../shared/schemas";
import { type ILogger, getLogger } from "./logging";

let logger: ILogger;

export type WriteMode = "batch" | "force" | "final";

export type FileRunSettings = RunSettings & { languageSettings: LanguageSettings };

/**
 * Properties that are string file paths and should be normalized.
 * Based on runSettings.schema.json.
 */
const STRING_PATH_PROPERTIES = new Set([
  "interactorFile",
  "goodSolutionFile",
  "generatorFile",
  "currentWorkingDirectory",
]);

/**
 * Properties that are command arrays whose items may contain paths.
 * All items will be normalized (path.normalize is safe on any string).
 * Based on runSettings.schema.json.
 */
const COMMAND_ARRAY_PROPERTIES = new Set(["compileCommand", "runCommand", "debugCommand"]);

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
  private _finalWritten = false;

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
      this._finalWritten = true;
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

  write(_data: string, mode: WriteMode) {
    if (this._finalWritten) {
      return;
    }

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

    if (mode === "final" && this._data.at(-1) !== "\n") {
      this._appendPendingCharacter("\n");
      this._data += "\n";
    }
    this._sendPendingIfNeeded(mode === "force" || mode === "final");
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
    this._finalWritten = false;
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

function getRelativeFileDirname(relativeFilePath: string | undefined): string {
  if (!relativeFilePath) return "";
  const dir = path.dirname(relativeFilePath);
  return dir === "." ? "" : dir;
}

function getFileDirnameBasename(parsedPath: path.ParsedPath | undefined): string {
  if (!parsedPath) return "";
  return parsedPath.dir.substring(parsedPath.dir.lastIndexOf(path.sep) + 1);
}

function getLineNumber(activeEditor: vscode.TextEditor | undefined): string {
  return activeEditor ? String(activeEditor.selection.start.line + 1) : "";
}

function getSelectedText(activeEditor: vscode.TextEditor | undefined): string {
  if (!activeEditor) return "";
  return activeEditor.document.getText(
    new vscode.Range(activeEditor.selection.start, activeEditor.selection.end)
  );
}

function resolveStringVariables(
  string: string,
  inContextOfFile?: string,
  extraVariables?: Record<string, string>,
  propertyName?: string
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
    "${relativeFileDirname}": getRelativeFileDirname(relativeFilePath),
    "${fileBasename}": parsedPath?.base ?? "",
    "${fileBasenameNoExtension}": parsedPath?.name ?? "",
    "${fileExtname}": parsedPath?.ext ?? "",
    "${fileDirname}": parsedPath?.dir ?? "",
    "${fileDirnameBasename}": getFileDirnameBasename(parsedPath),
    "${cwd}": parsedPath?.dir ?? "",
    "${lineNumber}": getLineNumber(activeEditor),
    "${selectedText}": getSelectedText(activeEditor),
    "${execPath}": process.execPath,
    "${pathSeparator}": path.sep,
    "${/}": path.sep,
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
      .map((variable) => variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "g"
  );
  const resolved = string.replace(variableRegex, (variable) => substitutions[variable]);

  // Normalize paths for known string path properties
  if (propertyName && STRING_PATH_PROPERTIES.has(propertyName)) {
    return path.normalize(resolved);
  }

  return resolved;
}

function resolveArrayVariables(
  array: unknown[],
  inContextOfFile?: string,
  extraVariables?: Record<string, string>,
  propertyName?: string
): unknown[] {
  // For command arrays, normalize all string items after variable resolution.
  // path.normalize() is safe to call on any string (flags, executables, paths).
  // This ensures consistent path separators for paths while leaving other strings unchanged.
  // Note: Node.js spawn() handles spaces in arguments correctly, so no quoting is needed.
  const isCommandArray = propertyName && COMMAND_ARRAY_PROPERTIES.has(propertyName);

  return array.map((item) => {
    const resolved = resolveVariables(item as never, inContextOfFile, extraVariables);

    // Normalize all string items in command arrays
    if (isCommandArray && typeof resolved === "string") {
      return path.normalize(resolved);
    }

    return resolved;
  });
}

function resolveObjectVariables(
  obj: Record<string, unknown>,
  inContextOfFile?: string,
  extraVariables?: Record<string, string>,
  propertyPath?: string
): Record<string, unknown> {
  void propertyPath; // suppress eslint
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    // Pass the current key as propertyName to child resolution
    result[key] = resolveVariables(val as never, inContextOfFile, extraVariables, key);
  }
  return result;
}

export function resolveVariables(
  value: string,
  inContextOfFile?: string,
  extraVariables?: Record<string, string>,
  propertyName?: string
): string;
export function resolveVariables(
  value: unknown[],
  inContextOfFile?: string,
  extraVariables?: Record<string, string>,
  propertyName?: string
): unknown[];
export function resolveVariables(
  value: Record<string, unknown>,
  inContextOfFile?: string,
  extraVariables?: Record<string, string>,
  propertyName?: string
): Record<string, unknown>;
export function resolveVariables(
  value: unknown,
  inContextOfFile?: string,
  extraVariables?: Record<string, string>,
  propertyName?: string
): unknown {
  if (Array.isArray(value)) {
    return resolveArrayVariables(value, inContextOfFile, extraVariables, propertyName);
  }
  if (typeof value === "object" && value !== null) {
    return resolveObjectVariables(
      value as Record<string, unknown>,
      inContextOfFile,
      extraVariables,
      propertyName
    );
  }
  if (typeof value === "string") {
    return resolveStringVariables(value, inContextOfFile, extraVariables, propertyName);
  }
  return value;
}

export async function openInNewEditor(content: string): Promise<void> {
  const uri = ReadonlyStringProvider.createUri(content);
  const document = await vscode.workspace.openTextDocument(uri);
  vscode.window.showTextDocument(document);
}

const _runSettingsCache = new Map<string, Record<string, unknown>>();
let _runSettingsWatcher: vscode.FileSystemWatcher | undefined = undefined;
let _schemaDefaults: Record<string, string> | undefined = undefined;
let _extensionContext: vscode.ExtensionContext | undefined = undefined;

/**
 * Loads default values from the runSettings.json schema file.
 * Caches the result after first load.
 */
function getSchemaDefaults(): Record<string, string> {
  if (_schemaDefaults) {
    return _schemaDefaults;
  }

  if (!_extensionContext) {
    logger.error("Extension context not initialized");
    return {};
  }

  try {
    const schemaPath = path.join(
      _extensionContext.extensionPath,
      "schemas",
      "runSettings.schema.json"
    );
    const schemaContent = fs.readFileSync(schemaPath, "utf8");
    const schema = JSON.parse(schemaContent);

    _schemaDefaults = {};
    if (schema.properties && typeof schema.properties === "object") {
      for (const [key, prop] of Object.entries(schema.properties)) {
        if (
          typeof prop === "object" &&
          prop !== null &&
          "default" in prop &&
          typeof (prop as { default: unknown }).default === "string"
        ) {
          _schemaDefaults[key] = (prop as { default: string }).default;
        }
      }
    }

    return _schemaDefaults;
  } catch (error) {
    logger.error(`Failed to load schema defaults: ${error}`);
    return {};
  }
}

/**
 * Initializes the file watcher for runSettings.json files.
 * Should be called once during extension activation.
 */
export function initializeRunSettingsWatcher(context: vscode.ExtensionContext): void {
  logger = getLogger("vscode");
  _extensionContext = context;

  if (_runSettingsWatcher) {
    return;
  }

  // Watch for runSettings.json files in all workspace folders
  _runSettingsWatcher = vscode.workspace.createFileSystemWatcher("**/runSettings.json");

  const clearCache = () => {
    _runSettingsCache.clear();
  };
  _runSettingsWatcher.onDidCreate(clearCache);
  _runSettingsWatcher.onDidChange(clearCache);
  _runSettingsWatcher.onDidDelete(clearCache);

  context.subscriptions.push(_runSettingsWatcher);
}

/**
 * Deep merges two objects, with the second object taking precedence.
 * Arrays are replaced (not merged), and nested objects are recursively merged.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };

  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = result[key];

    if (
      sourceValue &&
      typeof sourceValue === "object" &&
      !Array.isArray(sourceValue) &&
      targetValue &&
      typeof targetValue === "object" &&
      !Array.isArray(targetValue)
    ) {
      // Both are objects (not arrays), recursively merge
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      );
    } else {
      // Replace with source value (handles primitives, arrays, null, etc.)
      result[key] = sourceValue;
    }
  }

  return result;
}

/**
 * Loads and parses a runSettings.json file from the specified directory.
 * Returns undefined if the file doesn't exist or is invalid.
 */
function loadRunSettingsFromDirectory(directory: string): Record<string, unknown> | undefined {
  const cacheKey = directory;

  // Check cache first
  if (_runSettingsCache.has(cacheKey)) {
    return _runSettingsCache.get(cacheKey);
  }

  const runSettingsPath = path.join(directory, "runSettings.json");

  try {
    const content = fs.readFileSync(runSettingsPath, "utf8");
    const parsed = JSON.parse(content);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      logger.warn(`Invalid runSettings.json at ${runSettingsPath}: not an object`);
      return undefined;
    }

    _runSettingsCache.set(cacheKey, parsed as Record<string, unknown>);
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`Failed to read runSettings.json at ${runSettingsPath}: ${error}`);
    }
    return undefined;
  }
}

/**
 * Traverses from the file directory up to the workspace root,
 * loading and merging runSettings.json files along the way.
 * Also enforces the settings has the corresponding extension entry.
 * Returns the merged settings with all variables resolved and validated.
 * Automatically fills in default values for missing top-level properties.
 */
export function getFileRunSettings(
  file: string,
  extraVariables?: Record<string, string>
): FileRunSettings | null {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
  if (!workspaceFolder) {
    logger.error(`No workspace folder found for file ${file}`);
    vscode.window.showErrorMessage(`No workspace folder found for file ${file}`);
    return null;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;
  let currentDir = path.dirname(file);

  // Iterate from file folder back down to workspace root
  const settingsStack: Record<string, unknown>[] = [];
  while (currentDir.startsWith(workspaceRoot)) {
    const dirSettings = loadRunSettingsFromDirectory(currentDir);
    if (dirSettings) {
      settingsStack.push(dirSettings);
    }
    if (currentDir === workspaceRoot) {
      break;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break; // Reached filesystem root
    }
    currentDir = parentDir;
  }

  // Merge settings from workspace root down to file directory
  let mergedSettings: Record<string, unknown> = {};
  while (settingsStack.length > 0) {
    const settings = settingsStack.pop() ?? {};
    mergedSettings = deepMerge(mergedSettings, settings);
  }
  if (Object.keys(mergedSettings).length === 0) {
    logger.error(`No run settings found for ${file}`);
    showCreateRunSettingsErrorWindow(`No run settings found for ${file}`);
    return null;
  }

  // Fill in default values for missing properties before resolving variables
  const defaults = getSchemaDefaults();
  mergedSettings = deepMerge(defaults, mergedSettings);

  const resolved = resolveVariables(mergedSettings, file, extraVariables);

  const parseResult = v.safeParse(RunSettingsSchema, resolved);
  if (!parseResult.success) {
    logger.error(`Invalid runSettings.json for ${file}: ${parseResult.issues[0].message}`);
    showOpenRunSettingsErrorWindow(`Invalid run settings for ${file}`);
    return null;
  }

  const extension = path.extname(file);
  const languageSettings = parseResult.output[extension] as LanguageSettings | undefined;
  if (!languageSettings) {
    logger.error(`No language settings found for "${extension}"`);
    showAddLanguageSettingsError(`No language settings found for "${extension}"`, extension, file);
    return null;
  }

  return { ...parseResult.output, languageSettings };
}
export function showCreateRunSettingsErrorWindow(message: string): void {
  vscode.window.showErrorMessage(message, "Create Run Settings", "Close").then((choice) => {
    if (choice === "Create Run Settings") {
      vscode.commands.executeCommand("fastolympiccoding.createRunSettings");
    }
  });
}

export function showOpenRunSettingsErrorWindow(message: string): void {
  vscode.window.showErrorMessage(message, "Open Run Settings", "Close").then((choice) => {
    if (choice === "Open Run Settings") {
      vscode.commands.executeCommand("fastolympiccoding.openRunSettings");
    }
  });
}

export function showAddLanguageSettingsError(
  message: string,
  extension: string,
  file: string
): void {
  vscode.window.showErrorMessage(message, "Add Language Settings", "Close").then((choice) => {
    if (choice === "Add Language Settings") {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file));
      vscode.commands.executeCommand("fastolympiccoding.createRunSettings", {
        extension,
        workspaceFolder,
      });
    }
  });
}
