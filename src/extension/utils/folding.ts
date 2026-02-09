import * as vscode from "vscode";

type GetTemplateRangesCallback = (documentUri: string) => vscode.FoldingRange | undefined;

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
    const range = this.getTemplateRanges(document.uri.toString());
    return range ? [range] : [];
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
