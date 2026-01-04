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

export function registerWalkthroughCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("fastolympiccoding.createRunSettings", () => {
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
            placeHolder: "Select workspace folder for runSettings.json",
          });
          if (!picked) {
            return;
          }
          workspaceFolder = picked;
        }

        const runSettingsPath = path.join(workspaceFolder.uri.fsPath, "runSettings.json");
        try {
          await fs.access(runSettingsPath);
          const choice = await vscode.window.showWarningMessage(
            "runSettings.json already exists. Do you want to overwrite it?",
            "Yes",
            "Preview Examples",
            "Cancel"
          );
          if (choice === "Preview Examples") {
            const preview = await vscode.workspace.openTextDocument({
              language: "json",
              content: JSON.stringify(languageTemplates, undefined, 2),
            });
            vscode.window.showTextDocument(preview);
            return;
          }
          if (choice !== "Yes") {
            return;
          }
        } catch {
          // File doesn't exist, continue
        }

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

        await fs.writeFile(runSettingsPath, JSON.stringify(template, null, 2));

        const doc = await vscode.workspace.openTextDocument(runSettingsPath);
        await vscode.window.showTextDocument(doc);

        const languageList = languageChoices.join(", ");
        void vscode.window.showInformationMessage(
          `Created runSettings.json with ${languageList} template${languageChoices.length > 1 ? "s" : ""}`
        );
      })();
    })
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
            "runSettings.json not found. Would you like to create one?",
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
