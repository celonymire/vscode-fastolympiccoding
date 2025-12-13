import { Status } from "~shared/enums";

export function getStatusColor(status: Status): string {
  switch (status) {
    case Status.AC:
      return "var(--vscode-terminal-ansiGreen)";
    case Status.CE:
      return "var(--vscode-terminal-ansiYellow)";
    case Status.WA:
    case Status.RE:
    case Status.TL:
      return "var(--vscode-terminal-ansiRed)";
    default:
      return "var(--vscode-button-secondaryBackground)";
  }
}
