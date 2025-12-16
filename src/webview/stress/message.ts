import type { ProviderMessage } from "../../shared/stress-messages";

const vscode = acquireVsCodeApi();

export const postProviderMessage = (msg: ProviderMessage) => {
  vscode.postMessage(msg);
};
