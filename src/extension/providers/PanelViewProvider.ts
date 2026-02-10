import * as vscode from "vscode";
import type JudgeViewProvider from "./JudgeViewProvider";
import type StressViewProvider from "./StressViewProvider";
import { isListening, onDidChangeListening } from "../competitiveCompanion";
import { getStatusBarItem } from "../statusBar";

class StatusTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly description?: string,
    public readonly iconPath?: vscode.ThemeIcon,
    public readonly command?: vscode.Command,
    public readonly filePath?: string,
    public readonly context?: "judge" | "stress" | "companion"
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.iconPath = iconPath;
    this.command = command;
  }
}

export default class PopupViewProvider implements vscode.TreeDataProvider<StatusTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<StatusTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private _context: vscode.ExtensionContext,
    private _judgeViewProvider: JudgeViewProvider,
    private _stressViewProvider: StressViewProvider
  ) {
    this._context.subscriptions.push(onDidChangeListening(() => this.refresh()));
    this._context.subscriptions.push(
      this._judgeViewProvider.onDidChangeBackgroundTasks(() => this.refresh())
    );
    this._context.subscriptions.push(
      this._stressViewProvider.onDidChangeBackgroundTasks(() => this.refresh())
    );
    this._updateStatus();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
    this._updateStatus();
  }

  private _updateStatus() {
    const statusBarItem = getStatusBarItem();
    if (!statusBarItem) {
      return;
    }

    const config = vscode.workspace.getConfiguration("fastolympiccoding");
    const port = config.get<number>("port")!;
    const listening = isListening();

    // Status parts
    const parts: string[] = [];

    // Companion status
    if (listening) {
      parts.push(`$(radio-tower) ${port}`);
    }

    // Judge status
    const backgroundTasks = this._judgeViewProvider.getAllBackgroundTasks();
    let totalRunningTests = 0;
    for (const uuids of backgroundTasks.values()) {
      totalRunningTests += uuids.length;
    }

    // Stress status
    const stressSessions = this._stressViewProvider.getRunningStressSessions();
    totalRunningTests += stressSessions.length;

    if (totalRunningTests > 0) {
      parts.push(`$(loading~spin) ${totalRunningTests}`);
    }

    if (parts.length === 0) {
      statusBarItem.text = "$(zap) Fast Olympic Coding";
      statusBarItem.tooltip = "Open Fast Olympic Coding Panel";
      statusBarItem.backgroundColor = undefined;
    } else {
      let tooltip;
      if (totalRunningTests > 0) {
        tooltip = "View currently running sessions";
        statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      } else {
        tooltip = "Open Fast Olympic Coding Panel";
        statusBarItem.backgroundColor = undefined;
      }
      statusBarItem.text = `$(zap) Fast Olympic Coding: ${parts.join("  ")}`;
      statusBarItem.tooltip = tooltip;
    }
  }

  getTreeItem(element: StatusTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: StatusTreeItem): Thenable<StatusTreeItem[]> {
    if (!element) {
      // Root level items
      const config = vscode.workspace.getConfiguration("fastolympiccoding");
      const port = config.get<number>("port")!;
      const listening = isListening();

      // Show port only when listening
      const description = listening ? `Listening on port ${port}` : "Not listening";

      const companionItem = new StatusTreeItem(
        "Competitive Companion",
        vscode.TreeItemCollapsibleState.None,
        description,
        new vscode.ThemeIcon(listening ? "radio-tower" : "circle-slash"),
        undefined,
        undefined,
        "companion"
      );
      companionItem.contextValue = listening ? "companion-listening" : "companion-stopped";

      // Get count of background judge tasks
      const backgroundTasks = this._judgeViewProvider.getAllBackgroundTasks();
      const judgeTaskCount = backgroundTasks.size;
      const judgeDescription =
        judgeTaskCount > 0 ? `${judgeTaskCount} file${judgeTaskCount > 1 ? "s" : ""}` : undefined;

      const judgeItem = new StatusTreeItem(
        "Judge Testcases",
        vscode.TreeItemCollapsibleState.Expanded,
        judgeDescription,
        new vscode.ThemeIcon("run"),
        undefined,
        undefined,
        "judge"
      );
      judgeItem.contextValue = "judge-background-group";

      // Get count of background stress tasks
      const stressSessions = this._stressViewProvider.getRunningStressSessions();
      const stressSessionCount = stressSessions.length;
      const stressDescription =
        stressSessionCount > 0
          ? `${stressSessionCount} file${stressSessionCount > 1 ? "s" : ""}`
          : undefined;

      const stressItem = new StatusTreeItem(
        "Stress Test Processes",
        vscode.TreeItemCollapsibleState.Expanded,
        stressDescription,
        new vscode.ThemeIcon("debug-alt"),
        undefined,
        undefined,
        "stress"
      );
      stressItem.contextValue = "stress-background-group";

      return Promise.resolve([companionItem, judgeItem, stressItem]);
    }

    if (element.label === "Judge Testcases") {
      const backgroundTasks = this._judgeViewProvider.getAllBackgroundTasks();
      const items: StatusTreeItem[] = [];

      for (const [file, uuids] of backgroundTasks.entries()) {
        const relativePath = vscode.workspace.asRelativePath(file);
        const item = new StatusTreeItem(
          relativePath,
          vscode.TreeItemCollapsibleState.None,
          `${uuids.length} test${uuids.length > 1 ? "s" : ""} running`,
          new vscode.ThemeIcon("loading~spin"),
          {
            command: "vscode.open",
            title: "Open File",
            arguments: [vscode.Uri.file(file)],
          },
          file,
          "judge"
        );
        item.contextValue = "judge-background-file";
        items.push(item);
      }

      // Sort by file name
      items.sort((a, b) => a.label.localeCompare(b.label));
      return Promise.resolve(items);
    }

    if (element.label === "Stress Test Processes") {
      const stressSessions = this._stressViewProvider.getRunningStressSessions();
      const items: StatusTreeItem[] = [];

      for (const file of stressSessions) {
        const relativePath = vscode.workspace.asRelativePath(file);
        const item = new StatusTreeItem(
          relativePath,
          vscode.TreeItemCollapsibleState.None,
          "Running",
          new vscode.ThemeIcon("loading~spin"),
          {
            command: "vscode.open",
            title: "Open File",
            arguments: [vscode.Uri.file(file)],
          },
          file,
          "stress"
        );
        item.contextValue = "stress-background-file";
        items.push(item);
      }

      // Sort by file name
      items.sort((a, b) => a.label.localeCompare(b.label));
      return Promise.resolve(items);
    }

    return Promise.resolve([]);
  }
}
