export type RunReporterPhase = {
  start(): void;
  tick(increment?: number, attrs?: Record<string, unknown>): void;
  set(current: number, total?: number, attrs?: Record<string, unknown>): void;
  end(status?: "ok" | "warn" | "fail", detail?: string): void;
};

export type RunReporterStats = {
  progressEmits: number;
  eventCount: number;
  errorCount: number;
  warningCount: number;
};

export type RunReporter = {
  phase(name: string, total?: number): RunReporterPhase;
  logEvent(
    kind: string,
    payload?: {
      phase?: string | null;
      counters?: { current: number; total: number };
      ms?: number;
      attrs?: Record<string, unknown>;
    }
  ): void;
  warning(message: string, attrs?: Record<string, unknown>): void;
  error(
    code: string,
    message: string,
    options?: {
      file?: string;
      line?: number;
      col?: number;
      phase?: string;
      attrs?: Record<string, unknown>;
    }
  ): void;
  finalize(summary?: { status?: string; [key: string]: unknown }): void;
  flush(): Promise<void>;
  getStats(): RunReporterStats;
};

export function createRunReporter(options: {
  tool: string;
  runId?: string;
  outputDir?: string;
  minIntervalMs?: number;
  enableConsole?: boolean;
}): RunReporter;
