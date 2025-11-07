import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import * as vscode from "vscode";

import type { ILanguageSettings, IProblem } from "~shared/provider";
import { compile } from "~extension/utils/runtime";
import {
  ReadonlyStringProvider,
  resolveVariables,
} from "~extension/utils/vscode";
import JudgeViewProvider from "./providers/judge/JudgeViewProvider";
import StressViewProvider from "./providers/stress/StressViewProvider";

let judgeViewProvider: JudgeViewProvider;
let stressViewProvider: StressViewProvider;
let competitiveCompanionServer: http.Server | undefined;

let competitiveCompanionStatusItem: vscode.StatusBarItem;

interface IDependencies {
  [file: string]: string[];
}

async function getFileContent(
  file: string,
  baseDirectory: string,
  dependencies: IDependencies
) {
  const visiting: Set<string> = new Set();
  const visited: Set<string> = new Set();
  const order: string[] = [];

  const hasCycle = (function dfs(currentFile: string): boolean {
    if (visiting.has(currentFile)) {
      return true;
    }
    if (visited.has(currentFile)) {
      return false;
    }
    let cycle = false;
    visiting.add(currentFile);
    if (currentFile in dependencies) {
      for (const dependency of dependencies[currentFile]) {
        cycle ||= dfs(dependency);
      }
    }
    visiting.delete(currentFile);
    visited.add(currentFile);
    order.push(currentFile);
    return cycle;
  })(file);
  if (hasCycle) {
    const choice = await vscode.window.showWarningMessage(
      "Cyclic dependency found! Do you still want to insert the template?",
      "Yes",
      "No"
    );
    if (choice === "No") {
      return undefined;
    }
  }

  const contents = await Promise.all(
    order.map((file) => fs.readFile(path.join(baseDirectory, file), "utf-8"))
  );
  const combined = contents.join("\n");
  return combined;
}

function registerViewProviders(context: vscode.ExtensionContext): void {
  judgeViewProvider = new JudgeViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      judgeViewProvider.getViewId(),
      judgeViewProvider
    )
  );

  stressViewProvider = new StressViewProvider(context, judgeViewProvider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      stressViewProvider.getViewId(),
      stressViewProvider
    )
  );
}

function registerDocumentContentProviders(
  context: vscode.ExtensionContext
): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      ReadonlyStringProvider.SCHEME,
      new ReadonlyStringProvider()
    )
  );
}

function registerCommands(context: vscode.ExtensionContext): void {
  const compilationStatusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    10000
  );
  compilationStatusItem.name = "Compilation Status";
  compilationStatusItem.text = "$(zap) Compiling...";
  compilationStatusItem.backgroundColor = new vscode.ThemeColor(
    "statusBarItem.warningBackground"
  );
  compilationStatusItem.hide(); // enable and disable it as necessary
  context.subscriptions.push(compilationStatusItem);

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      "fastolympiccoding.compile",
      () => {
        const file = vscode.window.activeTextEditor?.document.fileName;
        if (!file) {
          return;
        }

        const runSettings = vscode.workspace.getConfiguration(
          "fastolympiccoding.runSettings"
        );
        const extension = path.extname(file);
        const languageSettings = runSettings[extension] as
          | ILanguageSettings
          | undefined;
        if (!languageSettings) {
          vscode.window.showWarningMessage(
            `No run setting detected for file extension "${extension}"`
          );
          return;
        }
        if (languageSettings.compileCommand) {
          void compile(file, languageSettings.compileCommand, context); // we don't care about exit code of compilation
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand("fastolympiccoding.runAll", () =>
      judgeViewProvider.runAll()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand("fastolympiccoding.stopAll", () =>
      judgeViewProvider.stopAll()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      "fastolympiccoding.deleteAll",
      () => judgeViewProvider.deleteAll()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand("fastolympiccoding.saveAll", () =>
      judgeViewProvider.saveAll()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      "fastolympiccoding.startStressTest",
      () => void stressViewProvider.run()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      "fastolympiccoding.stopStressTest",
      () => stressViewProvider.stop()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      "fastolympiccoding.clearStressTest",
      () => stressViewProvider.clear()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      "fastolympiccoding.clearData",
      () => {
        judgeViewProvider.clearData();
        stressViewProvider.clearData();
        judgeViewProvider.loadCurrentFileData();
        stressViewProvider.loadCurrentFileData();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      "fastolympiccoding.insertFileTemplate",
      () => {
        void (async () => {
          const config = vscode.workspace.getConfiguration("fastolympiccoding");
          const dependencies = config.get<IDependencies>(
            "fileTemplatesDependencies"
          );
          const baseDirectory = resolveVariables(
            // biome-ignore lint/style/noNonNullAssertion: Default value provided by VSCode
            config.get("fileTemplatesBaseDirectory")!
          );
          const files = (
            await fs.readdir(baseDirectory, {
              recursive: true,
              withFileTypes: true,
            })
          ).filter((value) => value.isFile());
          const items = files.map((file) => ({
            label: file.name,
            description: file.path,
          }));
          const pickedFile = await vscode.window.showQuickPick(items, {
            title: "Insert File Template",
          });
          if (!pickedFile) {
            return;
          }

          const content = await getFileContent(
            path.relative(
              baseDirectory,
              path.join(pickedFile.description, pickedFile.label)
            ),
            baseDirectory,
            dependencies ?? {}
          );
          if (!content) {
            return;
          }

          const inserted = vscode.window.activeTextEditor?.edit(
            (edit: vscode.TextEditorEdit) => {
              if (vscode.window.activeTextEditor) {
                edit.insert(
                  vscode.window.activeTextEditor.selection.active,
                  content
                );
              }
            }
          );
          // biome-ignore lint/style/noNonNullAssertion: Default value provided by VSCode
          const foldTemplate = config.get<boolean>("foldFileTemplate")!;
          if (inserted && foldTemplate) {
            vscode.commands.executeCommand("editor.fold");
          }
        })();
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "fastolympiccoding.listenForCompetitiveCompanion",
      () => listenForCompetitiveCompanion()
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "fastolympiccoding.stopCompetitiveCompanion",
      () => stopCompetitiveCompanion()
    )
  );
}

function listenForCompetitiveCompanion() {
  if (competitiveCompanionServer !== undefined) {
    return;
  }

  let problemDatas: IProblem[] = [];
  let cnt = 0;
  competitiveCompanionServer = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.end();
      return;
    }

    let ccData = "";
    req.setEncoding("utf-8");
    req.on("data", (data) => {
      ccData += data;
    });
    req.on("end", () => {
      void (async () => {
        res.end(() => req.socket.unref());

        problemDatas.push(JSON.parse(ccData) as IProblem);
        if (problemDatas.length === 0) {
          return;
        }

        vscode.window.showInformationMessage(
          `Received data for "${problemDatas[problemDatas.length - 1].name}"`
        );

        if (cnt === 0) {
          cnt = problemDatas[0].batch.size;
        }
        if (--cnt > 0) {
          return;
        }

        const file = vscode.window.activeTextEditor?.document.fileName;
        const workspace =
          vscode.workspace.workspaceFolders?.at(0)?.uri.fsPath ?? "";
        const config = vscode.workspace.getConfiguration("fastolympiccoding");
        // biome-ignore lint/style/noNonNullAssertion: Default value provided by VSCode
        const openSelectedFiles = config.get<boolean>("openSelectedFiles")!;
        // biome-ignore lint/style/noNonNullAssertion: Default value provided by VSCode
        const askForWhichFile = config.get<boolean>("askForWhichFile")!;
        // biome-ignore lint/style/noNonNullAssertion: Default value provided by VSCode
        const includePattern = config.get<string>("includePattern")!;
        // biome-ignore lint/style/noNonNullAssertion: Default value provided by VSCode
        const excludePattern = config.get<string>("excludePattern")!;
        const files = (
          await vscode.workspace.findFiles(includePattern, excludePattern)
        ).map((file) => ({
          label: path.parse(file.fsPath).base,
          description: path.parse(path.relative(workspace, file.fsPath)).dir,
        }));
        const filePaths: string[] = [];
        for (let i = 0; i < problemDatas.length; i++) {
          let fileTo =
            problemDatas[i].batch.size === 1 && file
              ? path.relative(workspace, file)
              : "";
          if (askForWhichFile || problemDatas[i].batch.size > 1 || !file) {
            const pick = vscode.window.createQuickPick();
            pick.title = `Testcases for "${problemDatas[i].name}"`;
            pick.placeholder = "Full file path to put testcases onto";
            pick.value = fileTo;
            pick.ignoreFocusOut = true;
            pick.items = files;
            pick.totalSteps = problemDatas[0].batch.size;
            pick.step = i + 1;
            pick.show();
            fileTo = await new Promise((resolve) => {
              pick.onDidAccept(() => {
                if (pick.selectedItems.length === 0) {
                  resolve(pick.value);
                } else {
                  resolve(
                    path.join(
                      pick.selectedItems[0].description ?? "",
                      pick.selectedItems[0].label
                    )
                  );
                }
                pick.hide();
              });
              pick.onDidHide(() => resolve(""));
            });
          }
          if (fileTo === "") {
            vscode.window.showWarningMessage(
              `No file to write testcases for "${problemDatas[i].name}"`
            );
            continue;
          }
          fileTo = path.join(workspace, fileTo);
          await fs.writeFile(fileTo, "", { flag: "a" });

          judgeViewProvider.addFromCompetitiveCompanion(
            fileTo,
            problemDatas[i]
          );
          filePaths.push(fileTo);
        }
        if (openSelectedFiles) {
          for (const filePath of filePaths) {
            const document = await vscode.workspace.openTextDocument(
              vscode.Uri.file(filePath)
            );
            await vscode.window.showTextDocument(document);
          }
        }
        problemDatas = [];
      })();
    });
  });

  competitiveCompanionServer.once("connection", (socket) => {
    socket.unref();
  });
  competitiveCompanionServer.once("listening", () => {
    competitiveCompanionStatusItem.show();
  });
  competitiveCompanionServer.once("error", (error) =>
    vscode.window.showErrorMessage(
      `Competitive Companion listener error: ${error}`
    )
  );
  competitiveCompanionServer.once("close", () => {
    competitiveCompanionServer = undefined;
    competitiveCompanionStatusItem.hide();
  });

  const config = vscode.workspace.getConfiguration("fastolympiccoding");
  // biome-ignore lint/style/noNonNullAssertion: Default value provided by VSCode
  const port = config.get<number>("port")!;
  competitiveCompanionServer.listen(port);
}

function stopCompetitiveCompanion() {
  if (competitiveCompanionServer === undefined) {
    return;
  }

  competitiveCompanionServer.close();
}

function createCompetitiveCompanionStatus(context: vscode.ExtensionContext) {
  const competitiveCompanionStatus = vscode.window.createStatusBarItem(
    "fastolympiccoding.listeningForCompetitiveCompanion",
    vscode.StatusBarAlignment.Left
  );
  competitiveCompanionStatus.name = "Competitive Companion Indicator";
  competitiveCompanionStatus.text = "$(zap)";
  competitiveCompanionStatus.tooltip = "Listening For Competitive Companion";
  competitiveCompanionStatus.hide();
  context.subscriptions.push(competitiveCompanionStatus);

  return competitiveCompanionStatus;
}

export function activate(context: vscode.ExtensionContext): void {
  registerViewProviders(context);
  registerCommands(context);
  registerDocumentContentProviders(context);
  listenForCompetitiveCompanion();

  competitiveCompanionStatusItem = createCompetitiveCompanionStatus(context);
}
