import * as vscode from "vscode";
import type JudgeViewProvider from "./JudgeViewProvider";
import type StressViewProvider from "./StressViewProvider";
import { isListening, onDidChangeListening } from "../competitiveCompanion";

class StatusTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly description?: string,
    public readonly iconPath?: vscode.ThemeIcon,
    public readonly command?: vscode.Command
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

      return Promise.resolve([
        companionItem,
        new StatusTreeItem(
          "Quick Actions",
          vscode.TreeItemCollapsibleState.Expanded,
          undefined,
          new vscode.ThemeIcon("zap")
        ),
        new StatusTreeItem(
          "Judge Status",
          vscode.TreeItemCollapsibleState.Expanded,
          undefined,
          new vscode.ThemeIcon("list-selection")
        ),
        new StatusTreeItem(
          "Stress Test Status",
          vscode.TreeItemCollapsibleState.Expanded,
          undefined,
          new vscode.ThemeIcon("debug-alt")
        ),
        new StatusTreeItem(
          "Recent Activity",
          vscode.TreeItemCollapsibleState.Expanded,
          undefined,
          new vscode.ThemeIcon("history")
        ),
      ]);
    }

    // Children based on parent
    switch (element.label) {
      case "Quick Actions":
        return Promise.resolve([
          new StatusTreeItem(
            "Run All Tests",
            vscode.TreeItemCollapsibleState.None,
            "Execute all testcases",
            new vscode.ThemeIcon("run-all"),
            {
              command: "fastolympiccoding.runAll",
              title: "Run All Tests",
            }
          ),
          new StatusTreeItem(
            "Clear Data",
            vscode.TreeItemCollapsibleState.None,
            "Clear saved testcases",
            new vscode.ThemeIcon("clear-all"),
            {
              command: "fastolympiccoding.clearData",
              title: "Clear Data",
            }
          ),
        ]);

      case "Judge Status":
        return Promise.resolve([
          new StatusTreeItem(
            "No active tests",
            vscode.TreeItemCollapsibleState.None,
            "Click to view Judge panel",
            new vscode.ThemeIcon("info"),
            {
              command: "fastolympiccoding.judge.focus",
              title: "Open Judge",
            }
          ),
        ]);

      case "Stress Test Status":
        return Promise.resolve([
          new StatusTreeItem(
            "Not running",
            vscode.TreeItemCollapsibleState.None,
            "Click to view Stress panel",
            new vscode.ThemeIcon("info"),
            {
              command: "fastolympiccoding.stress.focus",
              title: "Open Stress",
            }
          ),
        ]);

      case "Recent Activity":
        return Promise.resolve([
          new StatusTreeItem(
            "No recent activity",
            vscode.TreeItemCollapsibleState.None,
            undefined,
            new vscode.ThemeIcon("circle-outline")
          ),
        ]);

      default:
        return Promise.resolve([]);
    }
  }
}
