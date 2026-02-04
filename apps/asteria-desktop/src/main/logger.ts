import fs from "node:fs/promises";
import path from "node:path";
import { getRunLogDir } from "./run-paths.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LoggerConfig = {
  level?: string;
  per_page_logs?: boolean;
  keep_logs?: boolean;
};

export type RunLogger = {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
  page: (pageId: string, level: LogLevel, message: string, meta?: Record<string, unknown>) => void;
  finalize: () => Promise<void>;
};

const normalizeLevel = (value: string | undefined): LogLevel => {
  const normalized = String(value ?? "info").toLowerCase();
  if (normalized === "debug") return "debug";
  if (normalized === "warn" || normalized === "warning") return "warn";
  if (normalized === "error") return "error";
  return "info";
};

const safeStringify = (payload: unknown): string => {
  try {
    return JSON.stringify(payload);
  } catch {
    return JSON.stringify({ message: "Failed to serialize log payload" });
  }
};

const writeLine = async (filePath: string, payload: Record<string, unknown>): Promise<void> => {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(filePath, `${safeStringify(payload)}\n`);
};

export const createRunLogger = (runDir: string, config?: LoggerConfig): RunLogger => {
  const level = normalizeLevel(config?.level);
  const perPage = config?.per_page_logs ?? false;
  const keepLogs = config?.keep_logs ?? true;
  const logDir = getRunLogDir(runDir);
  const runLogPath = path.join(logDir, "run.log");
  const pageLogDir = path.join(logDir, "pages");

  const shouldLog = (entryLevel: LogLevel): boolean =>
    LEVEL_WEIGHT[entryLevel] >= LEVEL_WEIGHT[level];

  const log = (entryLevel: LogLevel, message: string, meta?: Record<string, unknown>): void => {
    if (!shouldLog(entryLevel)) return;
    const payload = {
      timestamp: new Date().toISOString(),
      level: entryLevel,
      message,
      ...(meta ?? {}),
    };
    void writeLine(runLogPath, payload).catch(() => undefined);
  };

  const logPage = (
    pageId: string,
    entryLevel: LogLevel,
    message: string,
    meta?: Record<string, unknown>
  ): void => {
    if (!perPage || !shouldLog(entryLevel)) return;
    const payload = {
      timestamp: new Date().toISOString(),
      level: entryLevel,
      pageId,
      message,
      ...(meta ?? {}),
    };
    const filePath = path.join(pageLogDir, `${pageId}.log`);
    void writeLine(filePath, payload).catch(() => undefined);
  };

  const finalize = async (): Promise<void> => {
    if (keepLogs) return;
    try {
      await fs.rm(logDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  };

  return {
    debug: (message, meta) => log("debug", message, meta),
    info: (message, meta) => log("info", message, meta),
    warn: (message, meta) => log("warn", message, meta),
    error: (message, meta) => log("error", message, meta),
    page: logPage,
    finalize,
  };
};

export const createNullLogger = (): RunLogger => ({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  page: () => undefined,
  finalize: async () => undefined,
});
