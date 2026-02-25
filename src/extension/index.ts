import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

import { compile, clearCompileCache } from "./utils/runtime";
import { createListener, stopCompetitiveCompanion } from "./competitiveCompanion";
import { registerRunSettingsCommands } from "./runSettingsCommands";
import {
  initializeRunSettingsWatcher,
  ReadonlyStringProvider,
  resolveVariables,
} from "./utils/vscode";
import { initLogging } from "./utils/logging";
import { TemplateFoldingProvider } from "./utils/folding";
import JudgeViewProvider from "./providers/JudgeViewProvider";
import StressViewProvider from "./providers/StressViewProvider";
import PanelViewProvider from "./providers/PanelViewProvider";
import { showChangelog } from "./changelog";
import { createStatusBarItem } from "./statusBar";

let judgeViewProvider: JudgeViewProvider;
let stressViewProvider: StressViewProvider;
let panelViewProvider: PanelViewProvider;
let templateFoldingProvider: TemplateFoldingProvider;

type Dependencies = Record<string, string[]>;

// Track inserted template ranges by document URI for folding
const templateRangesByUri = new Map<string, vscode.FoldingRange>();

async function getTemplateContent(
  relativeFile: string,
  baseDirectory: string,
  dependencies: Dependencies
): Promise<string | undefined> {
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
  })(relativeFile);
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

  const results = await Promise.allSettled(
    order.map((file) => {
      return fs.readFile(path.join(baseDirectory, file));
    })
  );
  const errors = results
    .map((result, index) => {
      return {
        file: order[index],
        status: result.status,
        reason: result.status === "rejected" ? result.reason : undefined,
      };
    })
    .filter((item) => item.status === "rejected");
  if (errors.length > 0) {
    for (const error of errors) {
      vscode.window.showErrorMessage(`Error reading ${error.file}: ${error.reason}`);
    }
    return undefined;
  }

  // at this point every file is guaranteed to be fulfilled
  const combined = results
    .map((result) => (result as PromiseFulfilledResult<Buffer>).value.toString())
    .join("\n");
  return combined;
}

function registerViewProviders(context: vscode.ExtensionContext): void {
  judgeViewProvider = new JudgeViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(judgeViewProvider.getViewId(), judgeViewProvider)
  );

  stressViewProvider = new StressViewProvider(context, judgeViewProvider);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(stressViewProvider.getViewId(), stressViewProvider)
  );

  // Panel tree view in panel area (bottom)
  panelViewProvider = new PanelViewProvider(context, judgeViewProvider, stressViewProvider);
  context.subscriptions.push(
    vscode.window.createTreeView("fastolympiccoding.panel", {
      treeDataProvider: panelViewProvider,
      showCollapseAll: false,
    })
  );
}

function registerDocumentContentProviders(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      ReadonlyStringProvider.SCHEME,
      new ReadonlyStringProvider()
    )
  );

  // Clean up the content map when documents are closed to prevent memory leaks
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      ReadonlyStringProvider.cleanup(document.uri);
      // Also clean up template ranges for closed documents
      templateRangesByUri.delete(document.uri.toString());
    })
  );
}

function registerFoldingProvider(context: vscode.ExtensionContext): void {
  // Create the folding provider with a callback to get template ranges
  templateFoldingProvider = new TemplateFoldingProvider((documentUri) => {
    return templateRangesByUri.get(documentUri);
  });

  // Register for all file scheme documents
  context.subscriptions.push(
    vscode.languages.registerFoldingRangeProvider({ scheme: "file" }, templateFoldingProvider)
  );

  // Dispose the provider when extension deactivates
  context.subscriptions.push(templateFoldingProvider);
}

function registerCommands(context: vscode.ExtensionContext): void {
  registerRunSettingsCommands(context);

  const compilationStatusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    10000
  );
  compilationStatusItem.name = "Compilation Status";
  compilationStatusItem.text = "$(zap) Compiling...";
  compilationStatusItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  compilationStatusItem.hide(); // enable and disable it as necessary
  context.subscriptions.push(compilationStatusItem);

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand("fastolympiccoding.compile", () => {
      void (async () => {
        const file = vscode.window.activeTextEditor?.document.fileName;
        if (file) {
          void compile(file, context); // we don't care about exit code of compilation
        }
      })();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("fastolympiccoding.clearCompileCache", () => {
      clearCompileCache();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand("fastolympiccoding.runAll", () =>
      judgeViewProvider.runAll()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand("fastolympiccoding.debugAll", () =>
      judgeViewProvider.debugAll()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand("fastolympiccoding.stopAll", () =>
      judgeViewProvider.stopAll()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand("fastolympiccoding.deleteAll", () =>
      judgeViewProvider.deleteAll()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("fastolympiccoding.importTestcases", async () => {
      const file = judgeViewProvider.getActiveFilePath();
      if (!file) {
        await vscode.window.showWarningMessage("Open a file in Judge before importing testcases");
        return;
      }

      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        openLabel: "Import Testcases",
        filters: {
          JSON: ["json"],
        },
      });
      const importUri = selected?.[0];
      if (!importUri) {
        return;
      }

      try {
        const content = await fs.readFile(importUri.fsPath, "utf8");
        const rawData = JSON.parse(content) as unknown;
        const importedCount = judgeViewProvider.appendImportedTestcasesForFile(file, rawData);

        if (importedCount === 0) {
          await vscode.window.showWarningMessage("No testcases found in the selected JSON file");
          return;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(`Failed to import testcases: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("fastolympiccoding.exportTestcases", async () => {
      const file = judgeViewProvider.getActiveFilePath();
      if (!file) {
        await vscode.window.showWarningMessage("Open a file in Judge before exporting testcases");
        return;
      }

      const defaultUri = vscode.Uri.file(`${file}.testcases.json`);
      const exportUri = await vscode.window.showSaveDialog({
        saveLabel: "Export Testcases",
        defaultUri,
        filters: {
          JSON: ["json"],
        },
      });

      if (!exportUri) {
        return;
      }

      try {
        const testcases = judgeViewProvider.exportTestcasesForFile(file);
        await fs.writeFile(exportUri.fsPath, JSON.stringify(testcases, null, 2), "utf8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(`Failed to export testcases: ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand("fastolympiccoding.toggleJudgeSettings", () =>
      judgeViewProvider.toggleWebviewSettings()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand("fastolympiccoding.openInteractorFile", () =>
      judgeViewProvider.openInteractorFile()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand(
      "fastolympiccoding.startStressTest",
      () => void stressViewProvider.run()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand("fastolympiccoding.stopStressTest", () =>
      stressViewProvider.stop()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand("fastolympiccoding.clearStressTest", () =>
      stressViewProvider.clear()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand("fastolympiccoding.toggleStressSettings", () =>
      stressViewProvider.toggleWebviewSettings()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand("fastolympiccoding.clearData", () => {
      judgeViewProvider.clearData();
      stressViewProvider.clearData();
      judgeViewProvider.loadCurrentFileData();
      stressViewProvider.loadCurrentFileData();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerTextEditorCommand("fastolympiccoding.insertFileTemplate", () => {
      void (async () => {
        const config = vscode.workspace.getConfiguration("fastolympiccoding");
        const dependencies = config.get<Dependencies>("fileTemplatesDependencies");
        const baseDirectory = resolveVariables(
          config.get("fileTemplatesBaseDirectory") ?? "${workspaceFolder}"
        );
        const workspaceRoot = vscode.workspace.workspaceFolders?.at(0)?.uri.fsPath ?? "";
        const relativeBaseDirectory = path.relative(workspaceRoot, baseDirectory);
        const include = relativeBaseDirectory === "" ? "**" : `${relativeBaseDirectory}/**`;
        const files = await vscode.workspace.findFiles(include);
        const items = files.map((file) => ({
          label: path.parse(file.fsPath).base,
          description: path.relative(baseDirectory, file.fsPath),
        }));
        const pickedFile = await vscode.window.showQuickPick(items, {
          title: "Insert File Template",
          matchOnDescription: true,
        });
        if (!pickedFile) {
          return;
        }

        const content = await getTemplateContent(
          pickedFile.description,
          baseDirectory,
          dependencies ?? {}
        );
        if (!content) {
          return;
        }

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          return;
        }

        const start = editor.selection.active.line;
        const newlineCount = (content.match(/\n/g) || []).length;
        const originalSelection = editor.selection;

        const inserted = await editor.edit((edit: vscode.TextEditorEdit) => {
          edit.insert(editor.selection.active, content);
        });

        if (!inserted) {
          return;
        }

        const foldTemplate = config.get<boolean>("foldFileTemplate")!;
        if (foldTemplate) {
          // Track the template range for folding
          // newlineCount is the number of newline characters; the range spans from start to start + newlineCount
          const end = start + newlineCount;
          const documentUri = editor.document.uri.toString();
          templateRangesByUri.set(documentUri, new vscode.FoldingRange(start, end));

          // Notify the folding provider that ranges have changed
          templateFoldingProvider.notifyFoldingRangesChanged();

          // Wait for VS Code's internal folding debounce (~200ms), then fold
          setTimeout(async () => {
            // Move cursor to the start of the template so fold operates on the template region
            const startPos = new vscode.Position(start, 0);
            editor.selection = new vscode.Selection(startPos, startPos);

            // Fold at the cursor position
            await vscode.commands.executeCommand("editor.fold", { levels: 1, direction: "down" });

            // Restore the original selection
            editor.selection = originalSelection;
            templateRangesByUri.delete(documentUri);
          }, 200);
        }
      })();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("fastolympiccoding.listenForCompetitiveCompanion", () =>
      createListener(judgeViewProvider)
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("fastolympiccoding.stopCompetitiveCompanion", () =>
      stopCompetitiveCompanion()
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("fastolympiccoding.showChangelog", () => showChangelog(context))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("fastolympiccoding.showPanel", () => {
      vscode.commands.executeCommand("fastolympiccoding.panel.focus");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "fastolympiccoding.stopBackgroundTests",
      (item: { filePath?: string }) => {
        if (item?.filePath) {
          void judgeViewProvider.stopBackgroundTasksForFile(item.filePath);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "fastolympiccoding.stopStressSession",
      (item: { filePath?: string }) => {
        if (item?.filePath) {
          stressViewProvider.stopStressSession(item.filePath);
        }
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("fastolympiccoding.stopAllStressSessions", () => {
      stressViewProvider.stopAll();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("fastolympiccoding.stopAllBackgroundTests", () => {
      void judgeViewProvider.stopAllBackgroundTasks();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("fastolympiccoding.changePort", async () => {
      const config = vscode.workspace.getConfiguration("fastolympiccoding");
      const currentPort = config.get<number>("port")!;
      const newPort = await vscode.window.showInputBox({
        title: "Change Competitive Companion Port",
        value: currentPort.toString(),
        validateInput: (value) => {
          const port = parseInt(value, 10);
          if (isNaN(port) || port < 1024 || port > 65535) {
            return "Port must be a number between 1024 and 65535";
          }
          return undefined;
        },
      });

      if (newPort !== undefined) {
        await config.update("port", parseInt(newPort, 10), vscode.ConfigurationTarget.Global);
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration("fastolympiccoding.port")) {
        await stopCompetitiveCompanion();
        createListener(judgeViewProvider);
      }
    })
  );
}

export function activate(context: vscode.ExtensionContext): void {
  initLogging(context);
  initializeRunSettingsWatcher(context);
  void showChangelog(context, true);

  registerViewProviders(context);
  registerCommands(context);
  registerDocumentContentProviders(context);
  registerFoldingProvider(context);

  createStatusBarItem(context);

  const config = vscode.workspace.getConfiguration("fastolympiccoding");
  const autoStart = config.get<boolean>("automaticallyStartCompetitiveCompanion", true);
  if (autoStart) {
    createListener(judgeViewProvider);
  }
}
