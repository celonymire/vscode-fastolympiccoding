import * as vscode from "vscode";
import { getLogger } from "./logging";

export interface TemplateRange {
  startLine: number;
  endLine: number;
}

type GetTemplateRangesCallback = (documentUri: string) => TemplateRange | undefined;

/**
 * Custom folding provider that folds inserted template regions.
 * Returns a single folding range for the entire template content.
 */
export class TemplateFoldingProvider implements vscode.FoldingRangeProvider {
  private readonly _onDidChangeFoldingRangesEmitter = new vscode.EventEmitter<void>();
  public readonly onDidChangeFoldingRanges = this._onDidChangeFoldingRangesEmitter.event;

  constructor(private readonly getTemplateRanges: GetTemplateRangesCallback) {}

  provideFoldingRanges(
    document: vscode.TextDocument
  ): vscode.ProviderResult<vscode.FoldingRange[]> {
    const templateRange = this.getTemplateRanges(document.uri.toString());
    if (!templateRange) {
      return [];
    }

    const logger = getLogger("folding");
    logger.debug(
      `Providing folding range for ${document.uri.fsPath}: ${templateRange.startLine}-${templateRange.endLine}`
    );

    // Simply fold the entire inserted template region
    return [new vscode.FoldingRange(templateRange.startLine, templateRange.endLine)];
  }

  /**
   * Notify VS Code that folding ranges have changed.
   * Call this after inserting a template to trigger re-evaluation.
   */
  notifyFoldingRangesChanged(): void {
    this._onDidChangeFoldingRangesEmitter.fire();
  }

  /**
   * Dispose of resources.
   */
  dispose(): void {
    this._onDidChangeFoldingRangesEmitter.dispose();
  }
}
