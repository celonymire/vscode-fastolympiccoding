import * as vscode from "vscode";
import * as path from "path";
import type JudgeViewProvider from "./JudgeViewProvider";
import type StressViewProvider from "./StressViewProvider";
import { isListening, onDidChangeListening } from "../competitiveCompanion";

class StatusTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly description?: string,
    public readonly iconPath?: vscode.ThemeIcon,
    public readonly command?: vscode.Command,
    public readonly filePath?: string
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
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
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
        new vscode.ThemeIcon(listening ? "broadcast" : "circle-slash"),
        undefined
      );
      companionItem.contextValue = listening ? "companion-listening" : "companion-stopped";

      // Get count of background judge tasks
      const backgroundTasks = this._judgeViewProvider.getAllBackgroundTasks();
      const judgeTaskCount = backgroundTasks.size;
      const judgeDescription =
        judgeTaskCount > 0 ? `${judgeTaskCount} file${judgeTaskCount > 1 ? "s" : ""}` : undefined;

      return Promise.resolve([
        companionItem,
        new StatusTreeItem(
          "Judge Background Testcases",
          vscode.TreeItemCollapsibleState.Expanded,
          judgeDescription,
          new vscode.ThemeIcon("run"),
          undefined
        ),
        new StatusTreeItem(
          "Stress Test Background Processes",
          vscode.TreeItemCollapsibleState.Expanded,
          undefined,
          new vscode.ThemeIcon("debug-alt"),
          undefined
        ),
      ]);
    }

    // Children of "Judge Background Testcases"
    if (element.label === "Judge Background Testcases") {
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
          file
        );
        item.contextValue = "judge-background-file";
        items.push(item);
      }

      // Sort by file name
      items.sort((a, b) => a.label.localeCompare(b.label));
      return Promise.resolve(items);
    }

    return Promise.resolve([]);
  }
}
