import * as vscode from "vscode";
import * as v from "valibot";
import { ReadonlyStringProvider } from "../utils/vscode";

interface IWorkspaceState {
  [key: string]: unknown;
}

function getNonce(): string {
  const CHOICES = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += CHOICES.charAt(Math.floor(Math.random() * CHOICES.length));
  }
  return nonce;
}

export default abstract class BaseViewProvider<
  Schema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
  WebviewMessageType,
> implements vscode.WebviewViewProvider
{
  private _webview?: vscode.Webview = undefined;
  private _onDidChangeActiveTextEditorDisposable?: vscode.Disposable;
  protected _currentFile?: string;

  constructor(
    readonly view: string,
    protected _context: vscode.ExtensionContext,
    private _schema: Schema
  ) {}

  abstract onMessage(msg: v.InferOutput<Schema>): void;
  abstract onShow(): void;

  onDispose(): void {
    this._onDidChangeActiveTextEditorDisposable?.dispose();
    this._onDidChangeActiveTextEditorDisposable = undefined;
  }

  // --- File persistence lifecycle (common to Judge/Stress) ---

  // Subclasses must implement these to handle file switching
  protected abstract _switchToNoFile(): void;
  protected abstract _switchToFile(file: string): void;
  protected abstract _rehydrateWebviewFromState(): void;
  protected abstract _sendShowMessage(visible: boolean): void;

  // Override in subclass if "same file" rehydration requires a state check (e.g., Judge checks _state.size > 0)
  protected _hasState(): boolean {
    return true;
  }

  loadCurrentFileData(): void {
    this._ensureActiveEditorListener();
    this._syncOrSwitchToTargetFile();
  }

  protected _ensureActiveEditorListener(): void {
    if (this._onDidChangeActiveTextEditorDisposable) {
      return;
    }
    this._onDidChangeActiveTextEditorDisposable = vscode.window.onDidChangeActiveTextEditor(
      (editor) => this._handleActiveEditorChange(editor),
      this
    );
  }

  protected _handleActiveEditorChange(editor?: vscode.TextEditor): void {
    const document = editor?.document;

    if (
      !document ||
      (document.uri.scheme !== "file" && document.uri.scheme !== "untitled") ||
      document.uri.scheme === ReadonlyStringProvider.SCHEME
    ) {
      if (vscode.window.visibleTextEditors.length === 0) {
        this._switchToNoFile();
      }
      return;
    }

    const file = document.fileName;
    if (file !== this._currentFile) {
      this._switchToFile(file);
    }
  }

  protected _getTargetFile(): string | undefined {
    return vscode.window.activeTextEditor?.document.fileName ?? this._currentFile;
  }

  protected _syncOrSwitchToTargetFile(): void {
    const file = this._getTargetFile();
    if (!file) {
      this._sendShowMessage(false);
      return;
    }

    // If we are already on this file, just rehydrate the webview from in-memory state.
    if (file === this._currentFile && this._hasState()) {
      this._sendShowMessage(true);
      this._rehydrateWebviewFromState();
      return;
    }

    // Different file (or same file without state): switch to it (loads from storage).
    if (file !== this._currentFile) {
      this._switchToFile(file);
      return;
    }

    // Same file but no state (e.g., first load): just rehydrate (will load defaults).
    this._rehydrateWebviewFromState();
  }

  // --- End file persistence lifecycle ---

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._webview = webviewView.webview;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._context.extensionUri, "dist")],
    };
    webviewView.webview.html = this._getWebviewContent(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
      const result = v.safeParse(this._schema, message);
      if (result.success) {
        this.onMessage(result.output);
      } else {
        console.error("Invalid message received:", result.issues);
      }
    });
    webviewView.onDidDispose(() => this.onDispose());
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.onShow();
      }
    });
  }

  getViewId(): string {
    return `fastolympiccoding.${this.view}`;
  }

  readStorage(): IWorkspaceState {
    const data = this._context.workspaceState.get(this.view, {} as IWorkspaceState);
    if (!data || typeof data !== "object") {
      return {};
    }
    return data;
  }

  writeStorage(file: string, data?: object) {
    const fileData = this._context.workspaceState.get(this.view, {});
    this._context.workspaceState.update(this.view, {
      ...fileData,
      [`${file}`]: data,
    });
  }

  clearData() {
    this._context.workspaceState.update(this.view, undefined);
  }

  protected _postMessage(msg: WebviewMessageType): void {
    this._webview?.postMessage(msg);
  }

  private _getWebviewContent(webview: vscode.Webview): string {
    const scriptUri = this._getUri(webview, ["dist", this.view, "index.js"]);
    const stylesUri = this._getUri(webview, ["dist", this.view, "index.css"]);
    const codiconsUri = this._getUri(webview, ["dist", "codicons", "codicon.css"]);
    const nonce = getNonce();

    return `
        <!DOCTYPE html>
        <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} https:; script-src 'nonce-${nonce}';">
                <link rel="stylesheet" href="${stylesUri}">
                <link rel="stylesheet" href="${codiconsUri}">
            </head>
        <body>
            <div id="root"></div>
            <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
        </body>
        </html>
        `;
  }

  private _getUri(webview: vscode.Webview, paths: string[]) {
    return webview
      .asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, ...paths))
      .toString();
  }
}
