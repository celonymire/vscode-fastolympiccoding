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
import JudgeViewProvider from "./providers/JudgeViewProvider";
import StressViewProvider from "./providers/StressViewProvider";
import PanelViewProvider from "./providers/PanelViewProvider";
import { showChangelog } from "./changelog";
import { createStatusBarItem } from "./statusBar";

let judgeViewProvider: JudgeViewProvider;
let stressViewProvider: StressViewProvider;
let panelViewProvider: PanelViewProvider;

type Dependencies = Record<string, string[]>;

async function getFileContent(file: string, baseDirectory: string, dependencies: Dependencies) {
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
    })
  );
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
    vscode.commands.registerTextEditorCommand("fastolympiccoding.toggleJudgeSettings", () =>
      judgeViewProvider.toggleWebviewSettings()
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
        const baseDirectory = resolveVariables(config.get("fileTemplatesBaseDirectory")!);
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
          path.relative(baseDirectory, path.join(pickedFile.description, pickedFile.label)),
          baseDirectory,
          dependencies ?? {}
        );
        if (!content) {
          return;
        }

        const inserted = vscode.window.activeTextEditor?.edit((edit: vscode.TextEditorEdit) => {
          if (vscode.window.activeTextEditor) {
            edit.insert(vscode.window.activeTextEditor.selection.active, content);
          }
        });
        const foldTemplate = config.get<boolean>("foldFileTemplate")!;
        if (inserted && foldTemplate) {
          vscode.commands.executeCommand("editor.fold");
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
}

export function activate(context: vscode.ExtensionContext): void {
  initLogging(context);
  initializeRunSettingsWatcher(context);
  void showChangelog(context, true);

  registerViewProviders(context);
  registerCommands(context);
  registerDocumentContentProviders(context);

  createStatusBarItem(context);

  const config = vscode.workspace.getConfiguration("fastolympiccoding");
  const autoStart = config.get<boolean>("automaticallyStartCompetitiveCompanion", true);
  if (autoStart) {
    createListener(judgeViewProvider);
  }
}
