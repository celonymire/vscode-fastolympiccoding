import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

const languageTemplates: Record<string, object> = {
  "C++": {
    ".cpp": {
      compileCommand: ["g++", "${file}", "-o", "${fileDirname}/${fileBasenameNoExtension}"],
      runCommand: ["${fileDirname}/${fileBasenameNoExtension}"],
    },
  },
  Python: {
    ".py": {
      runCommand: ["python", "${file}"],
    },
  },
  Java: {
    ".java": {
      compileCommand: ["javac", "${file}"],
      runCommand: ["java", "-cp", "${fileDirname}", "${fileBasenameNoExtension}"],
    },
  },
};

function createGenericTemplate(extension: string): object {
  return {
    [extension]: {
      runCommand: ["TODO"],
      compileCommand: ["TODO! REMOVE IF NOT NEEDED"],
    },
  };
}

function getLanguageTemplateForExtension(extension: string): object | null {
  for (const languageTemplate of Object.values(languageTemplates)) {
    if (extension in languageTemplate) {
      return { [extension]: languageTemplate[extension as keyof typeof languageTemplate] };
    }
  }
  return null;
}

async function mergeSettingsIntoFile(runSettingsPath: string, newSettings: object): Promise<void> {
  let existingSettings: Record<string, unknown> = {};

  try {
    const content = await fs.readFile(runSettingsPath, "utf8");
    existingSettings = JSON.parse(content) as Record<string, unknown>;
  } catch {
    // File doesn't exist or is invalid, start fresh
  }

  const mergedSettings = { ...existingSettings, ...newSettings };
  await fs.writeFile(runSettingsPath, JSON.stringify(mergedSettings, null, 2));
}

function getActiveFileExtension(): string | null {
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor) {
    return null;
  }
  return path.extname(activeEditor.document.fileName);
}

export function registerWalkthroughCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "fastolympiccoding.createRunSettings",
      async (options?: { extension?: string; workspaceFolder?: vscode.WorkspaceFolder }) => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
          void vscode.window.showErrorMessage("No workspace folder is open");
          return;
        }

        let workspaceFolder: vscode.WorkspaceFolder;
        if (options?.workspaceFolder) {
          workspaceFolder = options.workspaceFolder;
        } else if (workspaceFolders.length === 1) {
          workspaceFolder = workspaceFolders[0];
        } else {
          const picked = await vscode.window.showWorkspaceFolderPick({
            placeHolder: "Select workspace folder for run settings",
          });
          if (!picked) {
            return;
          }
          workspaceFolder = picked;
        }

        const runSettingsPath = path.join(workspaceFolder.uri.fsPath, "runSettings.json");
        const fileExists = await fs
          .access(runSettingsPath)
          .then(() => true)
          .catch(() => false);

        // If extension is provided (auto-add scenario), merge settings and open file
        if (options?.extension) {
          const template =
            getLanguageTemplateForExtension(options.extension) ??
            createGenericTemplate(options.extension);

          await mergeSettingsIntoFile(runSettingsPath, template);

          const doc = await vscode.workspace.openTextDocument(runSettingsPath);
          await vscode.window.showTextDocument(doc);

          void vscode.window.showInformationMessage(
            `Added ${options.extension} settings to run settings`
          );
          return;
        }

        // If file exists, ask what to do
        if (fileExists) {
          const choice = await vscode.window.showWarningMessage(
            "runSettings.json already exists. What would you like to do?",
            "Add Language",
            "Preview Examples",
            "Cancel"
          );
          if (choice === "Preview Examples") {
            const preview = await vscode.workspace.openTextDocument({
              language: "json",
              content: JSON.stringify(languageTemplates, undefined, 2),
            });
            void vscode.window.showTextDocument(preview);
            return;
          }
          if (choice !== "Add Language") {
            return;
          }
        }

        // Try to auto-detect language from active file
        const activeExtension = getActiveFileExtension();
        if (activeExtension) {
          const template =
            getLanguageTemplateForExtension(activeExtension) ??
            createGenericTemplate(activeExtension);

          await mergeSettingsIntoFile(runSettingsPath, template);

          const doc = await vscode.workspace.openTextDocument(runSettingsPath);
          await vscode.window.showTextDocument(doc);

          void vscode.window.showInformationMessage(
            `Added ${activeExtension} settings to run settings`
          );
          return;
        }

        // No context available, ask user to pick languages
        const languageChoices = await vscode.window.showQuickPick(Object.keys(languageTemplates), {
          placeHolder: "Select one or more languages",
          canPickMany: true,
        });
        if (!languageChoices || languageChoices.length === 0) {
          return;
        }

        const template: Record<string, unknown> = {};
        for (const language of languageChoices) {
          Object.assign(template, languageTemplates[language]);
        }

        await mergeSettingsIntoFile(runSettingsPath, template);

        const doc = await vscode.workspace.openTextDocument(runSettingsPath);
        await vscode.window.showTextDocument(doc);

        const languageList = languageChoices.join(", ");
        void vscode.window.showInformationMessage(
          `Added ${languageList} template${languageChoices.length > 1 ? "s" : ""} to run settings`
        );
      }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("fastolympiccoding.openRunSettings", () => {
      void (async () => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
          void vscode.window.showErrorMessage("No workspace folder is open");
          return;
        }

        let workspaceFolder: vscode.WorkspaceFolder;
        if (workspaceFolders.length === 1) {
          workspaceFolder = workspaceFolders[0];
        } else {
          const picked = await vscode.window.showWorkspaceFolderPick({
            placeHolder: "Select workspace folder",
          });
          if (!picked) {
            return;
          }
          workspaceFolder = picked;
        }

        const runSettingsPath = path.join(workspaceFolder.uri.fsPath, "runSettings.json");
        try {
          await fs.access(runSettingsPath);
          const doc = await vscode.workspace.openTextDocument(runSettingsPath);
          await vscode.window.showTextDocument(doc);
        } catch {
          const create = await vscode.window.showInformationMessage(
            "Run settings not found. Would you like to create one?",
            "Yes",
            "No"
          );
          if (create === "Yes") {
            await vscode.commands.executeCommand("fastolympiccoding.createRunSettings");
          }
        }
      })();
    })
  );
}
