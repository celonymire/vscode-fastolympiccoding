import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import * as vscode from "vscode";
import * as v from "valibot";

import { ProblemSchema } from "~shared/schemas";
import type JudgeViewProvider from "~extension/providers/judge/JudgeViewProvider";

type Problem = v.InferOutput<typeof ProblemSchema>;

// Module state
let server: http.Server | undefined;
let serverPort: number | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;

/**
 * Shows a QuickPick to let the user select a target file for testcases.
 */
async function promptForTargetFile(
  problem: Problem,
  stepIndex: number,
  totalSteps: number,
  workspaceRoot: string,
  defaultValue: string
): Promise<string> {
  const config = vscode.workspace.getConfiguration("fastolympiccoding");
  const includePattern = config.get<string>("includePattern")!;
  const excludePattern = config.get<string>("excludePattern")!;

  const workspaceFiles = await vscode.workspace.findFiles(includePattern, excludePattern);
  const items = workspaceFiles.map((file) => ({
    label: path.parse(file.fsPath).base,
    description: path.parse(path.relative(workspaceRoot, file.fsPath)).dir,
  }));

  const pick = vscode.window.createQuickPick();
  pick.title = `Testcases for "${problem.name}"`;
  pick.placeholder = "Full file path to put testcases onto";
  pick.value = defaultValue;
  pick.ignoreFocusOut = true;
  pick.items = items;
  pick.totalSteps = totalSteps;
  pick.step = stepIndex + 1;
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
 * Processes a batch of problems received from Competitive Companion.
 */
async function processProblems(problems: Problem[], judge: JudgeViewProvider): Promise<void> {
  const activeFile = vscode.window.activeTextEditor?.document.fileName;
  const workspaceRoot = vscode.workspace.workspaceFolders?.at(0)?.uri.fsPath ?? "";
  const config = vscode.workspace.getConfiguration("fastolympiccoding");
  const openSelectedFiles = config.get<boolean>("openSelectedFiles")!;
  const askForWhichFile = config.get<boolean>("askForWhichFile")!;

  const processedFilePaths: string[] = [];

  for (let i = 0; i < problems.length; i++) {
    const problem = problems[i];
    const isSingleProblem = problem.batch.size === 1;
    const needsPrompt = askForWhichFile || !isSingleProblem || !activeFile;

    let relativePath =
      isSingleProblem && activeFile ? path.relative(workspaceRoot, activeFile) : "";

    if (needsPrompt) {
      relativePath = await promptForTargetFile(
        problem,
        i,
        problems[0].batch.size,
        workspaceRoot,
        relativePath
      );
    }

    if (relativePath === "") {
      vscode.window.showWarningMessage(`No file to write testcases for "${problem.name}"`);
      continue;
    }

    const absolutePath = path.join(workspaceRoot, relativePath);
    await fs.writeFile(absolutePath, "", { flag: "a" }); // Create file if it doesn't exist

    judge.addFromCompetitiveCompanion(absolutePath, problem);
    processedFilePaths.push(absolutePath);
  }

  if (openSelectedFiles) {
    for (const filePath of processedFilePaths) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
      await vscode.window.showTextDocument(document);
    }
  }
}

/**
 * Creates the request handler for the Competitive Companion HTTP server.
 */
function createRequestHandler(judge: JudgeViewProvider): http.RequestListener {
  let pendingProblems: Problem[] = [];
  let remainingInBatch = 0;

  return (req, res) => {
    if (req.method !== "POST") {
      res.end();
      return;
    }

    let body = "";
    req.setEncoding("utf-8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      void (async () => {
        res.end(() => req.socket.unref());

        // Parse and validate the problem data
        let problem: Problem;
        try {
          problem = v.parse(ProblemSchema, JSON.parse(body));
        } catch (error) {
          console.error("Invalid data from Competitive Companion received:", error);
          return;
        }

        pendingProblems.push(problem);
        vscode.window.showInformationMessage(`Received data for "${problem.name}"`);

        // Track batch progress
        if (remainingInBatch === 0) {
          remainingInBatch = problem.batch.size;
        }
        remainingInBatch--;

        // Process once all problems in batch are received
        if (remainingInBatch === 0) {
          await processProblems(pendingProblems, judge);
          pendingProblems = [];
        }
      })();
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
  server.once("error", (error) =>
    vscode.window.showErrorMessage(`Competitive Companion listener error: ${error}`)
  );
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
