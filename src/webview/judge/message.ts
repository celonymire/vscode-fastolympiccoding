import type { ProviderMessage } from "~shared/judge-messages";

const vscode = acquireVsCodeApi();

export const postProviderMessage = (msg: ProviderMessage) => {
  vscode.postMessage(msg);
};
