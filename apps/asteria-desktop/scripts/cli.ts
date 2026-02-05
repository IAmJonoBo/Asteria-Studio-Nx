/* eslint-disable no-console */

type StepStatus = "ok" | "warn" | "fail";

type Step = {
  end: (status?: StepStatus, detail?: string) => void;
};

const supportsColor = Boolean(process.stdout.isTTY);
const devLogs =
  process.env.ASTERIA_DEV_LOGS === "1" ||
  process.env.ASTERIA_DEV_LOGS === "true" ||
  process.env.DEBUG === "1";

const colorize = (code: string) => (value: string) =>
  supportsColor ? `\u001b[${code}m${value}\u001b[0m` : value;

const dim = colorize("2");
const green = colorize("32");
const yellow = colorize("33");
const red = colorize("31");
const cyan = colorize("36");

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${minutes}m ${remainder.toFixed(1)}s`;
};

const timestamp = (): string => {
  const now = new Date();
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
};

const statusLabel = (status: StepStatus): string => {
  if (status === "ok") return green("ok");
  if (status === "warn") return yellow("warn");
  return red("fail");
};

export const section = (title: string): void => {
  const width = Math.max(48, Math.min(80, title.length + 12));
  const rule = "=".repeat(width);
  console.log(`\n${rule}`);
  console.log(cyan(title));
  console.log(rule);
};

export const info = (message: string): void => {
  console.log(`  ${message}`);
};

export const note = (message: string): void => {
  console.log(dim(`  ${message}`));
};

export const devLog = (message: string): void => {
  if (!devLogs) return;
  console.log(dim(`  [dev] ${message}`));
};

type ProgressUpdate = {
  processed: number;
  total: number;
  stage?: string;
  throughput?: number;
};

type ProgressReporter = {
  update: (update: ProgressUpdate, force?: boolean) => void;
  end: (status?: StepStatus, detail?: string) => void;
};

const formatThroughput = (throughput?: number): string => {
  if (!throughput || !Number.isFinite(throughput)) return "";
  return ` • ${throughput.toFixed(2)} pages/sec`;
};

const formatProgress = (label: string, update: ProgressUpdate): string => {
  const { processed, total, stage } = update;
  const pct = total > 0 ? Math.min(100, Math.max(0, (processed / total) * 100)) : 0;
  const stageLabel = stage ? ` • ${stage}` : "";
  return `${label}: ${processed}/${total} (${pct.toFixed(1)}%)${stageLabel}${formatThroughput(
    update.throughput
  )}`;
};

export const createProgressReporter = (
  label: string,
  options?: { minIntervalMs?: number }
): ProgressReporter => {
  const minIntervalMs = options?.minIntervalMs ?? 250;
  let lastEmit = 0;
  let lastLine = "";
  const writeLine = (line: string): void => {
    if (process.stdout.isTTY) {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
      process.stdout.write(line);
    } else {
      console.log(`  ${line}`);
    }
  };
  const update = (progress: ProgressUpdate, force = false): void => {
    const now = Date.now();
    if (!force && now - lastEmit < minIntervalMs) return;
    const line = formatProgress(label, progress);
    if (line === lastLine && !force) return;
    lastEmit = now;
    lastLine = line;
    writeLine(line);
  };
  const end = (status: StepStatus = "ok", detail?: string): void => {
    if (process.stdout.isTTY) {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
    }
    const suffix = detail ? ` - ${detail}` : "";
    console.log(`${dim(timestamp())} [${statusLabel(status)}] ${label}${suffix}`);
  };
  return { update, end };
};

export const startStep = (label: string): Step => {
  const startedAt = Date.now();
  console.log(`${dim(timestamp())} [start] ${label}`);
  return {
    end: (status: StepStatus = "ok", detail?: string) => {
      const duration = formatDuration(Date.now() - startedAt);
      const suffix = detail ? ` - ${detail}` : "";
      console.log(
        `${dim(timestamp())} [${statusLabel(status)}] ${label}${suffix} ${dim(`(${duration})`)}`
      );
    },
  };
};
