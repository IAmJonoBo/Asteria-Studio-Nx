export interface PhaseHandle {
  start(): void;
  tick(amount?: number, attrs?: Record<string, unknown>): void;
  set(current: number, total?: number | null, attrs?: Record<string, unknown>): void;
  end(status?: string): void;
}

export interface RunReporterStats {
  progressEmits: number;
}

export interface RunReporterOptions {
  tool: string;
  runId?: string;
  outputDir?: string;
  minIntervalMs?: number;
  enableConsole?: boolean;
}

export interface ReporterErrorOptions {
  phase?: string;
  file?: string;
  line?: number;
  col?: number;
  attrs?: Record<string, unknown>;
}

export interface ReporterWarningOptions {
  phase?: string;
  attrs?: Record<string, unknown>;
}

export class RunReporter {
  tool: string;
  runId: string;
  outputDir?: string;
  phase(name: string, total?: number | null): PhaseHandle;
  warning(code: string, message: string, options?: ReporterWarningOptions): void;
  error(code: string, message: string, options?: ReporterErrorOptions): void;
  finalize(summary?: Record<string, unknown>): void;
  flush(): Promise<void>;
  getStats(): RunReporterStats;
}

export function createRunReporter(options: RunReporterOptions): RunReporter;
