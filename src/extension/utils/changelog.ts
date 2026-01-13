import * as vscode from "vscode";

const LAST_VERSION_KEY = "lastVersion";

/**
 * Compares two version strings. This assumes semver scheme.
 * @returns 1 if v1 > v2, -1 if v1 < v2, 0 if v1 === v2
 */
function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split(".").map(Number);
  const parts2 = v2.split(".").map(Number);
  const maxLength = Math.max(parts1.length, parts2.length);

  for (let i = 0; i < maxLength; i++) {
    const val1 = parts1[i] || 0;
    const val2 = parts2[i] || 0;
    if (val1 > val2) return 1;
    if (val1 < val2) return -1;
  }
  return 0;
}

/**
 * Shows the changelog. If `checkVersion` is true, it only shows a notification if the extension was updated.
 * Otherwise, it directly opens the CHANGELOG.md file.
 * @param context The extension context.
 * @param checkVersion Whether to check for an update before showing.
 */
export async function showChangelog(
  context: vscode.ExtensionContext,
  checkVersion = false
): Promise<void> {
  const currentVersion = context.extension.packageJSON.version as string;
  const lastVersion = context.globalState.get<string>(LAST_VERSION_KEY);

  if (checkVersion) {
    // If the version is newer or it's the first time, show notification
    if (lastVersion === undefined || compareVersions(currentVersion, lastVersion) > 0) {
      const choice = await vscode.window.showInformationMessage(
        `Fast Olympic Coding has updated to ${currentVersion}!`,
        "See What's New",
        "Dismiss"
      );

      if (choice === "See What's New") {
        await showChangelog(context);
      }

      // Update the last version stored
      await context.globalState.update(LAST_VERSION_KEY, currentVersion);
    } else if (compareVersions(currentVersion, lastVersion) < 0) {
      // If the user downgraded, we just update the stored version to the current one
      await context.globalState.update(LAST_VERSION_KEY, currentVersion);
    }
    return;
  }

  // Open the CHANGELOG.md file
  const changelogPath = vscode.Uri.file(context.asAbsolutePath("CHANGELOG.md"));
  try {
    await vscode.commands.executeCommand("markdown.showPreview", changelogPath);
  } catch (error) {
    console.error(`Failed to show changelog as markdown preview: ${error}`);

    // Fallback to opening as a regular text document if preview fails
    const doc = await vscode.workspace.openTextDocument(changelogPath);
    await vscode.window.showTextDocument(doc);
  }
}
