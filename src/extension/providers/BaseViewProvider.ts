import * as vscode from "vscode";
import * as v from "valibot";

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

  constructor(
    readonly view: string,
    protected _context: vscode.ExtensionContext,
    private _schema: Schema
  ) {}

  abstract onMessage(msg: v.InferOutput<Schema>): void;
  abstract onDispose(): void;
  abstract onShow(): void;

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
      } else {
        this.onDispose();
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
