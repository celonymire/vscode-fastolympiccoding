import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

import { deepMerge } from "./utils/vscode";

// FIXME: Kotlin debugging doesn't work well with single files.
// Remove all debugging configurations for Kotlin for now

const gdbAttachDebugConfig = {
  debugCommand: [
    "gdbserver",
    "localhost:${debugPort}",
    "${fileDirname}/${fileBasenameNoExtension}",
  ],
  debugAttachConfig: "GDB: Attach",
};
const javaAttachDebugConfig = {
  debugCommand: [
    "java",
    "-agentlib:jdwp=transport=dt_socket,server=y,suspend=y,address=${debugPort}",
    "-cp",
    "${fileDirname}",
    "${fileBasenameNoExtension}",
  ],
  debugAttachConfig: "Java: Attach",
};

const languageTemplates: Record<string, object> = {
  "C++ (GCC)": {
    ".cpp": {
      compileCommand: ["g++", "${file}", "-g", "-o", "${fileDirname}/${fileBasenameNoExtension}"],
      runCommand: ["${fileDirname}/${fileBasenameNoExtension}"],
      ...gdbAttachDebugConfig,
    },
  },
  "C++ (Clang)": {
    ".cpp": {
      compileCommand: [
        "clang++",
        "${file}",
        "-g",
        "-o",
        "${fileDirname}/${fileBasenameNoExtension}",
      ],
      runCommand: ["${fileDirname}/${fileBasenameNoExtension}"],
      ...gdbAttachDebugConfig,
    },
  },
  Python: {
    ".py": {
      runCommand: ["python", "${file}"],
      debugCommand: [
        "python",
        "-m",
        "debugpy",
        "--listen",
        "localhost:${debugPort}",
        "--wait-for-client",
        "${file}",
      ],
      debugAttachConfig: "Python: Attach",
    },
  },
  PyPy: {
    ".py": {
      runCommand: ["pypy3", "${file}"],
    },
  },
  Java: {
    ".java": {
      compileCommand: ["javac", "-g", "${file}"],
      runCommand: ["java", "-cp", "${fileDirname}", "${fileBasenameNoExtension}"],
      ...javaAttachDebugConfig,
    },
  },
  Go: {
    ".go": {
      compileCommand: ["go", "build", "-o", "${fileDirname}/${fileBasenameNoExtension}", "${file}"],
      runCommand: ["${fileDirname}/${fileBasenameNoExtension}"],
      debugCommand: [
        "dlv",
        "debug",
        "--headless",
        "--listen=localhost:${debugPort}",
        "--api-version=2",
        "--accept-multiclient",
        "${file}",
      ],
      debugAttachConfig: "Go: Attach",
    },
  },
  Rust: {
    ".rs": {
      compileCommand: ["rustc", "${file}", "-g", "-o", "${fileDirname}/${fileBasenameNoExtension}"],
      runCommand: ["${fileDirname}/${fileBasenameNoExtension}"],
      ...gdbAttachDebugConfig,
    },
  },
  JavaScript: {
    ".js": {
      runCommand: ["node", "${file}"],
      debugCommand: ["node", "--inspect-brk=localhost:${debugPort}", "${file}"],
      debugAttachConfig: "JavaScript: Attach",
    },
  },
  TypeScript: {
    ".ts": {
      runCommand: ["node", "--experimental-transform-types", "${file}"],
      debugCommand: [
        "node",
        "--experimental-transform-types",
        "--inspect-brk=localhost:${debugPort}",
        "${file}",
      ],
      debugAttachConfig: "JavaScript: Attach",
    },
  },
  Haskell: {
    ".hs": {
      compileCommand: [
        "ghc",
        "${file}",
        "-O",
        "-g",
        "-o",
        "${fileDirname}/${fileBasenameNoExtension}",
      ],
      runCommand: ["${fileDirname}/${fileBasenameNoExtension}"],
      ...gdbAttachDebugConfig,
    },
  },
  Ruby: {
    ".rb": {
      runCommand: ["ruby", "${file}"],
      debugCommand: ["rdbg", "--open", "--port", "${debugPort}", "--", "${file}"],
      debugAttachConfig: "Ruby: Attach",
    },
  },
  "C#": {
    ".cs": {
      compileCommand: [
        "csc",
        "-debug",
        "/out:${fileDirname}/${fileBasenameNoExtension}.exe",
        "${file}",
      ],
      runCommand: ["mono", "${fileDirname}/${fileBasenameNoExtension}.exe"],
      debugCommand: [
        "mono",
        "--debug",
        "--debugger-agent=transport=dt_socket,server=y,address=127.0.0.1:${debugPort},suspend=y",
        "${fileDirname}/${fileBasenameNoExtension}.exe",
      ],
      debugAttachConfig: "C#: Attach",
    },
  },
  Kotlin: {
    ".kt": {
      compileCommand: [
        "kotlinc",
        "${file}",
        "-include-runtime",
        "-d",
        "${fileDirname}/${fileBasenameNoExtension}.jar",
      ],
      runCommand: ["java", "-jar", "${fileDirname}/${fileBasenameNoExtension}.jar"],
    },
  },
};

const gdbAttachConfig = {
  name: "GDB: Attach",
  type: "cppdbg",
  request: "launch",
  program: "${fileDirname}/${fileBasenameNoExtension}",
  MIMode: "gdb",
  miDebuggerServerAddress: "localhost:${debugPort}",
  setupCommands: [
    {
      description: "Enable pretty-printing for gdb",
      text: "-enable-pretty-printing",
      ignoreFailures: true,
    },
  ],
  cwd: "${workspaceFolder}",
};
const javaAttachConfig = {
  name: "Java: Attach",
  type: "java",
  request: "attach",
  hostName: "localhost",
  port: "${debugPort}",
};
const javascriptAttachConfig = {
  name: "JavaScript: Attach",
  type: "node",
  request: "attach",
  port: "${debugPort}",
  address: "localhost",
  continueOnAttach: true,
};

const debugTemplates: Record<string, vscode.DebugConfiguration> = {
  "C++ (GCC)": gdbAttachConfig,
  "C++ (Clang)": gdbAttachConfig,
  Python: {
    name: "Python: Attach",
    type: "python",
    request: "attach",
    connect: {
      host: "localhost",
      port: "${debugPort}",
    },
  },
  Java: javaAttachConfig,
  Go: {
    name: "Go: Attach",
    type: "go",
    request: "attach",
    mode: "remote",
    port: "${debugPort}",
    host: "localhost",
  },
  Rust: gdbAttachConfig,
  JavaScript: javascriptAttachConfig,
  TypeScript: javascriptAttachConfig,
  "C#": {
    name: "C#: Attach",
    type: "mono",
    request: "attach",
    address: "localhost",
    port: "${debugPort}",
  },
  Ruby: {
    name: "Ruby: Attach",
    type: "rdbg",
    request: "attach",
    debugPort: "${debugPort}",
    localfs: true,
  },
  Haskell: gdbAttachConfig,
};

// extensions recommended for general use with each language
const recommendedExtensions: Record<string, string> = {
  "C++ (GCC)": "ms-vscode.cpptools",
  "C++ (Clang)": "ms-vscode.cpptools",
  Python: "ms-python.python",
  PyPy: "ms-python.python",
  Java: "redhat.java",
  Go: "golang.go",
  Haskell: "haskell.haskell",
  Kotlin: "JetBrains.kotlin",
};

// extensions recommended specifically for debugging support
const recommendedDebugExtensions: Record<string, string> = {
  Rust: "ms-vscode.cpptools",
  JavaScript: "ms-vscode.js-debug",
  Haskell: "ms-vscode.cpptools", // FIXME: Use "Well-Typed.haskell-debugger-extension" in the future
  Ruby: "KoichiSasada.vscode-rdbg",
  "C#": "ms-vscode.mono-debug",
};

function getGdbPrettyPrintersNote(language: string): string {
  return `${language} pretty printers are enabled but not loaded explicitly with gdbserver. Modify setupCommands in launch.json to explicitly load them`;
}

const languageDebugNotes: Record<string, string> = {
  "C++ (GCC)": getGdbPrettyPrintersNote("C++"),
  "C++ (Clang)": getGdbPrettyPrintersNote("C++"),
  Rust: getGdbPrettyPrintersNote("Rust"),
  Haskell: "Native Haskell debugging coming soon when remote attach is better supported",
  Kotlin:
    "Kotlin breakpoints are ignored with attachment for some reason, which is why there is temporarily no debug configuration. Sorry!",
};

function getDefaultTemplatesPreview(): Record<string, object> {
  let previewSettings = {};
  // We have to trim off the language name from the language templates
  for (const [, languageTemplate] of Object.entries(languageTemplates)) {
    previewSettings = { ...previewSettings, ...languageTemplate };
  }
  return previewSettings;
}

function createGenericTemplate(extension: string): object {
  return {
    [extension]: {
      runCommand: ["TODO"],
      compileCommand: ["TODO! REMOVE IF NOT NEEDED"],
      debugCommand: ["TODO! (Optional) Command to start debug server on ${debugPort}"],
      debugAttachConfig: "TODO! (Optional) Name of launch.json attach configuration",
    },
  };
}

function getLanguageTemplateForExtension(extension: string): {
  runSettings: object;
  debugConfig?: vscode.DebugConfiguration;
  language: string;
} | null {
  for (const [language, languageTemplate] of Object.entries(languageTemplates)) {
    if (extension in languageTemplate) {
      return {
        runSettings: {
          [extension]: languageTemplate[extension as keyof typeof languageTemplate],
        },
        debugConfig: debugTemplates[language],
        language,
      };
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

  // We want to keep the user's existing settings and only add the new settings,
  // thus the direction of the merge is reversed
  const mergedSettings = deepMerge(newSettings as Record<string, unknown>, existingSettings);
  await fs.writeFile(runSettingsPath, JSON.stringify(mergedSettings, null, 2));
}

async function mergeDebugConfigIntoFile(
  launchJsonPath: string,
  newConfig: vscode.DebugConfiguration
): Promise<void> {
  let existingLaunch: { version?: string; configurations?: vscode.DebugConfiguration[] } = {};

  try {
    const content = await fs.readFile(launchJsonPath, "utf8");
    existingLaunch = JSON.parse(content);
  } catch {
    // defaults
    existingLaunch = {
      version: "0.2.0",
      configurations: [],
    };
  }

  if (!existingLaunch.configurations) {
    existingLaunch.configurations = [];
  }

  const existingConfigIndex = existingLaunch.configurations.findIndex(
    (c) => c.name === newConfig.name
  );

  if (existingConfigIndex !== -1) {
    // Update existing configuration
    existingLaunch.configurations[existingConfigIndex] = {
      ...newConfig,
      ...existingLaunch.configurations[existingConfigIndex],
    };
  } else {
    // Add new configuration
    existingLaunch.configurations.push(newConfig);
  }

  // Use 4 spaces as indent to align with VSCode's default tab space
  await fs.writeFile(launchJsonPath, JSON.stringify(existingLaunch, null, 4));
}

function getActiveFileExtension(): string | null {
  const activeEditor = vscode.window.activeTextEditor;
  if (!activeEditor) {
    return null;
  }
  return path.extname(activeEditor.document.fileName);
}

export function registerRunSettingsCommands(context: vscode.ExtensionContext): void {
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
        const dotVscodeDir = path.join(workspaceFolder.uri.fsPath, ".vscode");
        const launchJsonPath = path.join(dotVscodeDir, "launch.json");

        const fileExists = await fs
          .access(runSettingsPath)
          .then(() => true)
          .catch(() => false);

        // Check if the user installed the recommended extension for the language
        const checkRecommendedExtensions = async (language: string) => {
          if (language in recommendedExtensions) {
            const extensionId = recommendedExtensions[language];
            const extension = vscode.extensions.getExtension(extensionId);
            if (!extension) {
              vscode.window
                .showInformationMessage(
                  `The '${extensionId}' extension is recommended for general ${language} development.`,
                  "View Extension",
                  "Close"
                )
                .then((choice) => {
                  if (choice === "View Extension") {
                    void vscode.commands.executeCommand("extension.open", extensionId);
                  }
                });
            }
          }

          if (language in recommendedDebugExtensions && language in debugTemplates) {
            const extensionId = recommendedDebugExtensions[language];
            const extension = vscode.extensions.getExtension(extensionId);
            if (!extension) {
              vscode.window
                .showInformationMessage(
                  `The '${extensionId}' extension is recommended for debugging ${language}.`,
                  "View Extension",
                  "Close"
                )
                .then((choice) => {
                  if (choice === "View Extension") {
                    void vscode.commands.executeCommand("extension.open", extensionId);
                  }
                });
            }
          }

          if (language in languageDebugNotes && language in debugTemplates) {
            void vscode.window.showInformationMessage(languageDebugNotes[language]);
          }
        };

        // Function to apply template updates
        const applyTemplate = async (
          template: object,
          language: string,
          debugConfig?: vscode.DebugConfiguration
        ) => {
          // Ensure .vscode directory exists for launch.json
          await fs.mkdir(dotVscodeDir, { recursive: true });

          // Merge run settings
          await mergeSettingsIntoFile(runSettingsPath, template);

          // Merge launch.json if we have a template for this language
          if (debugConfig) {
            await mergeDebugConfigIntoFile(launchJsonPath, debugConfig);
          }

          // Check for recommended extension in the applied template
          void checkRecommendedExtensions(language);
        };

        // If extension is provided (auto-add scenario), merge settings and open file
        if (options?.extension) {
          const result = getLanguageTemplateForExtension(options.extension);
          const template = result?.runSettings ?? createGenericTemplate(options.extension);

          await applyTemplate(template, result?.language ?? "", result?.debugConfig);

          const doc = await vscode.workspace.openTextDocument(runSettingsPath);
          await vscode.window.showTextDocument(doc);

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
              content: JSON.stringify(getDefaultTemplatesPreview(), undefined, 2),
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
          const result = getLanguageTemplateForExtension(activeExtension);
          const template = result?.runSettings ?? createGenericTemplate(activeExtension);

          await applyTemplate(template, result?.language ?? "", result?.debugConfig);

          const doc = await vscode.workspace.openTextDocument(runSettingsPath);
          await vscode.window.showTextDocument(doc);

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

        for (const language of languageChoices) {
          const template = languageTemplates[language];
          const debugConfig = debugTemplates[language];
          await applyTemplate(template, language, debugConfig);
        }

        const doc = await vscode.workspace.openTextDocument(runSettingsPath);
        await vscode.window.showTextDocument(doc);

        const languageList = languageChoices.join(", ");
        void vscode.window.showInformationMessage(
          `Merged ${languageList} template${languageChoices.length > 1 ? "s" : ""} to run settings`
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
