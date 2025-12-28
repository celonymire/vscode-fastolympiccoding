import * as vscode from "vscode";

export interface ILogger {
  trace: (message: string, ...args: unknown[]) => void;
  debug: (message: string, ...args: unknown[]) => void;
  info: (message: string, ...args: unknown[]) => void;
  warn: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

let logOutputChannel: vscode.LogOutputChannel | undefined;
const loggerCache = new Map<string, ReturnType<typeof createLogger>>();

/**
 * Initialize the extension's logging system.
 * Must be called during extension activation.
 *
 * @param context - Extension context for subscription management
 */
export function initLogging(context: vscode.ExtensionContext): void {
  if (logOutputChannel) {
    return; // Already initialized
  }

  logOutputChannel = vscode.window.createOutputChannel("Fast Olympic Coding", { log: true });
  context.subscriptions.push(logOutputChannel);
}

function createLogger(component: string): ILogger {
  return {
    trace: (message: string, ...args: unknown[]) =>
      logOutputChannel!.trace(`[${component}] ${message}`, ...args),
    debug: (message: string, ...args: unknown[]) =>
      logOutputChannel!.debug(`[${component}] ${message}`, ...args),
    info: (message: string, ...args: unknown[]) =>
      logOutputChannel!.info(`[${component}] ${message}`, ...args),
    warn: (message: string, ...args: unknown[]) =>
      logOutputChannel!.warn(`[${component}] ${message}`, ...args),
    error: (message: string, ...args: unknown[]) =>
      logOutputChannel!.error(`[${component}] ${message}`, ...args),
  };
}

/**
 * Get a component-scoped logger that wraps VS Code's LogOutputChannel.
 * Uses VS Code's built-in log levels (controlled via Developer: Set Log Level).
 * Loggers are cached per component.
 *
 * @param component - Component identifier (e.g., 'runtime', 'judge', 'stress', 'http')
 * @returns Object with trace/debug/info/warn/error logging methods
 */
export function getLogger(component: string): ILogger {
  if (!logOutputChannel) {
    throw new Error("Logging not initialized. Call initLogging() first.");
  }

  let logger = loggerCache.get(component);
  if (!logger) {
    logger = createLogger(component);
    loggerCache.set(component, logger);
  }
  return logger;
}
