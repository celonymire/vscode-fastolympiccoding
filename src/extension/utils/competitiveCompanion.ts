import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import * as vscode from "vscode";
import * as v from "valibot";

import { ProblemSchema } from "~shared/schemas";
import type JudgeViewProvider from "~extension/providers/JudgeViewProvider";

type Problem = v.InferOutput<typeof ProblemSchema>;

/**
 * Queue that processes problems sequentially as they arrive from Competitive Companion.
 * Gathers workspace files once before processing a batch of problems.
 */
class ProblemQueue {
  private queue: Problem[] = [];
  private processing = false;

  constructor(private processor: (problem: Problem, files: vscode.Uri[]) => Promise<void>) {}

  enqueue(problem: Problem): void {
    this.queue.push(problem);
    void this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    const files = await gatherWorkspaceFiles();
    while (this.queue.length > 0) {
      const problem = this.queue.shift()!;
      await this.processor(problem, files);
    }
    this.processing = false;
  }
}

// Module state
let server: http.Server | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

/**
 * Shows a QuickPick to let the user select a target file for testcases,
 * with the files provided.
 */
async function promptForTargetFile(
  problem: Problem,
  workspaceRoot: string,
  defaultValue: string,
  files: vscode.Uri[]
): Promise<string> {
  const config = vscode.workspace.getConfiguration("fastolympiccoding");
  const includePattern = config.get<string>("includePattern")!;
  const excludePattern = config.get<string>("excludePattern")!;

  const workspaceFiles = await vscode.workspace.findFiles(includePattern, excludePattern);
  const items = workspaceFiles.map((file) => ({
    label: path.parse(file.fsPath).base,
    description: path.parse(path.relative(workspaceRoot, file.fsPath)).dir,
  }));

  const options = files.map((file) => ({
    label: path.parse(file.fsPath).base,
    description: path.parse(path.relative(workspaceRoot, file.fsPath)).dir,
  }));

  const pick = vscode.window.createQuickPick();
  pick.title = `Testcases for "${problem.name}"`;
  pick.placeholder = "Full file path to put testcases onto";
  pick.items = options;
  pick.ignoreFocusOut = true;
  pick.items = items;
  pick.show();

  return new Promise((resolve) => {
    pick.onDidAccept(() => {
      const selected = pick.selectedItems[0];
      resolve(selected ? path.join(selected.description ?? "", selected.label) : pick.value);
      pick.hide();
    });
    pick.onDidHide(() => resolve(""));
  });
}

/**
 * Processes a single problem received from Competitive Companion.
 */
async function processProblem(
  problem: Problem,
  judge: JudgeViewProvider,
  files: vscode.Uri[]
): Promise<void> {
  const activeFile = vscode.window.activeTextEditor?.document.fileName;
  const workspaceRoot = vscode.workspace.workspaceFolders?.at(0)?.uri.fsPath ?? "";
  const config = vscode.workspace.getConfiguration("fastolympiccoding");
  const openSelectedFiles = config.get<boolean>("openSelectedFiles")!;
  const askForWhichFile = config.get<boolean>("askForWhichFile")!;

  const isSingleProblem = problem.batch.size === 1;
  const needsPrompt = askForWhichFile || !isSingleProblem || !activeFile;

  let relativePath = isSingleProblem && activeFile ? path.relative(workspaceRoot, activeFile) : "";

  if (needsPrompt) {
    relativePath = await promptForTargetFile(problem, workspaceRoot, relativePath, files);
  }

  if (relativePath === "") {
    vscode.window.showWarningMessage(`No file to write testcases for "${problem.name}"`);
    return;
  }

  const absolutePath = path.join(workspaceRoot, relativePath);
  await fs.writeFile(absolutePath, "", { flag: "a" }); // Create file if it doesn't exist

  judge.addFromCompetitiveCompanion(absolutePath, problem);

  if (openSelectedFiles) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
    await vscode.window.showTextDocument(document);
  }
}

/**
 * Gather files using VSCode's API with include and exclude patterns from settings.
 */
async function gatherWorkspaceFiles(): Promise<vscode.Uri[]> {
  const config = vscode.workspace.getConfiguration("fastolympiccoding");
  const includePattern = config.get<string>("includePattern")!;
  const excludePattern = config.get<string>("excludePattern")!;
  return vscode.workspace.findFiles(includePattern, excludePattern);
}

/**
 * Creates the request handler for the Competitive Companion HTTP server.
 */
function createRequestHandler(judge: JudgeViewProvider): http.RequestListener {
  const problemQueue = new ProblemQueue((problem, files) => processProblem(problem, judge, files));

  return (req, res) => {
    if (req.method !== "POST") {
      res.end();
      return;
    }

    let body = "";
    req.setEncoding("utf-8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.end(() => req.socket.unref());

      // Parse and validate the problem data
      let problem: Problem;
      try {
        problem = v.parse(ProblemSchema, JSON.parse(body));
      } catch (error) {
        console.error("Invalid data from Competitive Companion received:", error);
        return;
      }

      vscode.window.showInformationMessage(`Received data for "${problem.name}"`);
      problemQueue.enqueue(problem);
    });
  };
}

/**
 * Creates the status bar item for Competitive Companion.
 */
export function createStatusBarItem(context: vscode.ExtensionContext): vscode.StatusBarItem {
  statusBarItem = vscode.window.createStatusBarItem(
    "fastolympiccoding.listeningForCompetitiveCompanion",
    vscode.StatusBarAlignment.Left
  );
  statusBarItem.name = "Competitive Companion Indicator";
  statusBarItem.text = "$(zap)";
  statusBarItem.tooltip = "Listening For Competitive Companion";
  statusBarItem.hide();
  context.subscriptions.push(statusBarItem);

  return statusBarItem;
}

/**
 * Starts listening for Competitive Companion connections.
 */
export function createListener(judgeViewProvider: JudgeViewProvider): void {
  if (server !== undefined) {
    return;
  }

  server = http.createServer(createRequestHandler(judgeViewProvider));

  server.once("connection", (socket) => socket.unref());
  server.once("listening", () => statusBarItem?.show());
  server.once("error", (error) => {
    vscode.window.showErrorMessage(`Competitive Companion listener error: ${error}`);
    server?.close();
    server = undefined;
  });
  server.once("close", () => {
    server = undefined;
    statusBarItem?.hide();
  });

  const config = vscode.workspace.getConfiguration("fastolympiccoding");
  const port = config.get<number>("port")!;
  server.listen(port);
}

/**
 * Stops listening for Competitive Companion connections.
 */
export function stopCompetitiveCompanion(): void {
  server?.close();
  server = undefined;
}
