import * as vscode from "vscode";

let statusBarItem: vscode.StatusBarItem | undefined;

/**
 * Creates a general-purpose status bar item.
 */
export function createStatusBarItem(context: vscode.ExtensionContext): vscode.StatusBarItem {
  statusBarItem = vscode.window.createStatusBarItem(
    "fastolympiccoding.statusBarItem",
    vscode.StatusBarAlignment.Left
  );
  statusBarItem.name = "Fast Olympic Coding";
  statusBarItem.command = "fastolympiccoding.showPanel";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  return statusBarItem;
}

/**
 * Gets the status bar item instance.
 */
export function getStatusBarItem(): vscode.StatusBarItem | undefined {
  return statusBarItem;
}
