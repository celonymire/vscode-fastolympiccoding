import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as vscode from "vscode";
import * as v from "valibot";

import { ProblemSchema, type Testcase } from "../shared/schemas";
import type JudgeViewProvider from "./providers/JudgeViewProvider";
import { getLogger } from "./utils/logging";

type Problem = v.InferOutput<typeof ProblemSchema>;

/**
 * Queue that processes problems sequentially as they arrive from Competitive Companion.
 */
class ProblemQueue {
  private queue: Problem[] = [];
  private processing = false;

  constructor(private processor: (problem: Problem) => Promise<void>) {}

  enqueue(problem: Problem): void {
    this.queue.push(problem);
    void this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    while (this.queue.length > 0) {
      const problem = this.queue.shift()!;
      await this.processor(problem);
    }
    this.processing = false;
  }
}

// Module state
let server: http.Server | undefined;

let prevSelection: string | undefined;
let prevBatchId: string | undefined;

/**
 * Shows a QuickPick to let the user select a target file for testcases,
 * with the files provided.
 */
async function promptForTargetFile(
  problem: Problem,
  workspaceRoot: string,
  files: vscode.Uri[],
  currentFileRelativePath?: string
): Promise<string> {
  const options: vscode.QuickPickItem[] = files.map((file) => ({
    label: path.parse(file.fsPath).base,
    description: path.relative(workspaceRoot, file.fsPath),
  }));

  const pick = vscode.window.createQuickPick();
  pick.title = `Testcases for "${problem.name}"`;
  pick.placeholder = "Relative file path to put testcases onto";
  pick.items = options;
  pick.matchOnDescription = true;
  pick.ignoreFocusOut = true;

  // Auto-fill with current file if available
  if (currentFileRelativePath) {
    const { base: currentBase } = path.parse(currentFileRelativePath);

    // Try to find and pre-select the matching item
    const matchingItem = options.find(
      (item) => item.label === currentBase && item.description === currentFileRelativePath
    );
    if (matchingItem) {
      pick.activeItems = [matchingItem];
    }

    // Set the value to the current file path so users can edit it
    pick.value = currentFileRelativePath;
  }

  pick.show();

  return new Promise((resolve) => {
    pick.onDidChangeValue((value) => {
      if (!value.trim()) {
        pick.items = options;
        return;
      }

      const newItems = [...options];

      // Check if the path doesn't exist in the workspace files
      const pathExists = options.some((item) => item.description === value);
      if (!pathExists) {
        // Don't insert it at the beginning because it is subject to VSCode's
        // matching score for the display order anyways
        newItems.push({
          label: "Create New File",
          description: value,
          alwaysShow: true,
        });
      }

      pick.items = newItems;
    });

    pick.onDidAccept(() => {
      const selected = pick.selectedItems[0];
      // Use the selected item's description if available, otherwise use the custom input value
      // If the selected item is the "Create New File" option, use the previous selection as the file name
      const fileName = selected?.description ?? pick.value;
      resolve(fileName);
      prevSelection = fileName;
      prevBatchId = problem.batch.id;
      pick.hide();
    });
    pick.onDidHide(() => resolve(""));
  });
}

/**
 * Processes a single problem received from Competitive Companion.
 */
async function processProblem(problem: Problem, judge: JudgeViewProvider): Promise<void> {
  const activeFile = vscode.window.activeTextEditor?.document.fileName;
  const workspaceRoot = vscode.workspace.workspaceFolders?.at(0)?.uri.fsPath ?? "";
  const config = vscode.workspace.getConfiguration("fastolympiccoding");
  const openSelectedFiles = config.get<boolean>("openSelectedFiles")!;
  const askForWhichFile = config.get<boolean>("askForWhichFile")!;

  const isSingleProblem = problem.batch.size === 1;
  const needsPrompt = askForWhichFile || !isSingleProblem || !activeFile;

  let currentFileRelativePath;
  if (prevBatchId === problem.batch.id) {
    currentFileRelativePath = prevSelection;
  } else {
    currentFileRelativePath = activeFile ? path.relative(workspaceRoot, activeFile) : undefined;
  }
  let relativePath = isSingleProblem && currentFileRelativePath ? currentFileRelativePath : "";

  if (needsPrompt) {
    // Gather files before prompting to include newly created files from previous problems
    const updatedFiles = await gatherWorkspaceFiles();
    relativePath = await promptForTargetFile(
      problem,
      workspaceRoot,
      updatedFiles,
      currentFileRelativePath
    );
  }

  if (relativePath === "") {
    vscode.window.showWarningMessage(`No file to write testcases for "${problem.name}"`);
    return;
  }

  const absolutePath = path.join(workspaceRoot, relativePath);
  try {
    await fs.writeFile(absolutePath, "", { flag: "a" }); // Create file if it doesn't exist
  } catch (error) {
    const logger = getLogger("competitive-companion");
    logger.error(`Failed to create/write target file: ${absolutePath}`, error);
    vscode.window.showErrorMessage(`Failed to write file: ${absolutePath}`);
    return;
  }

  judge.deleteAll(absolutePath);
  for (const test of problem.tests) {
    const testcase: Testcase = {
      uuid: crypto.randomUUID(),
      stdin: test.input,
      stderr: "",
      stdout: "",
      acceptedStdout: test.output,
      elapsed: 0,
      memoryBytes: 0,
      status: "WA",
      shown: true,
      toggled: false,
      skipped: false,
      mode: problem.interactive ? "interactive" : "standard",
      interactorSecret: "",
    };
    judge.addTestcaseToFile(absolutePath, testcase, problem.timeLimit, problem.memoryLimit);
  }

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
  const problemQueue = new ProblemQueue((problem) => processProblem(problem, judge));

  return (req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end("Method Not Allowed");
      return;
    }

    let body = "";
    req.setEncoding("utf-8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      // Parse and validate the problem data
      let problem: Problem;
      try {
        problem = v.parse(ProblemSchema, JSON.parse(body));
      } catch (error) {
        const logger = getLogger("competitive-companion");
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.warn(`Invalid data received (${body.length} bytes): ${errorMsg}`);
        res.statusCode = 400;
        res.end("Bad Request");
        return;
      }

      res.statusCode = 200;
      res.end(() => req.socket.unref());

      vscode.window.showInformationMessage(`Received data for "${problem.name}"`);
      problemQueue.enqueue(problem);
    });
  };
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
  server.once("listening", () => {
    const config = vscode.workspace.getConfiguration("fastolympiccoding");
    const port = config.get<number>("port")!;
    const logger = getLogger("competitive-companion");
    logger.info(`Listener started on port ${port}`);
    _onDidChangeListening.fire(true);
  });
  server.once("error", (error) => {
    const logger = getLogger("competitive-companion");
    logger.error(`Listener error: ${error}`);
    vscode.window.showErrorMessage(`Competitive Companion listener error: ${error}`);
    server?.close();
    server = undefined;
  });
  server.once("close", () => {
    server = undefined;
    _onDidChangeListening.fire(false);
  });

  const config = vscode.workspace.getConfiguration("fastolympiccoding");
  const port = config.get<number>("port")!;
  server.listen(port);
}

/**
 * Stops listening for Competitive Companion connections.
 */
export function stopCompetitiveCompanion(): void {
  if (server) {
    server.close();
    server = undefined;
  }
}

export function isListening(): boolean {
  return server !== undefined;
}

const _onDidChangeListening = new vscode.EventEmitter<boolean>();
export const onDidChangeListening = _onDidChangeListening.event;
