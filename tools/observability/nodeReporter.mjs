import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const DEFAULT_BASE_DIR = path.join(ROOT, "artifacts", "observability");

const ensureDir = async (dir) => {
  await fs.mkdir(dir, { recursive: true });
};

const timestamp = () => new Date().toISOString();

const formatDuration = (ms) => {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return `${minutes}m ${remainder.toFixed(1)}s`;
};

class PhaseHandle {
  constructor(reporter, name, total) {
    this.reporter = reporter;
    this.name = name;
    this.total = total ?? null;
  }

  start() {
    this.reporter._startPhase(this.name, this.total);
  }

  tick(amount = 1, attrs) {
    this.reporter._tickPhase(this.name, amount, this.total, attrs);
  }

  set(current, total, attrs) {
    if (total !== undefined && total !== null) {
      this.total = total;
    }
    this.reporter._setPhase(this.name, current, this.total, attrs);
  }

  end(status = "ok") {
    this.reporter._endPhase(this.name, status);
  }
}

export class RunReporter {
  constructor({ tool, runId, outputDir, enableConsole = true, minIntervalMs = 100 }) {
    this.tool = tool;
    this.runId = runId;
    this.outputDir = outputDir;
    this.enableConsole = enableConsole;
    this.minIntervalMs = minIntervalMs;
    this.outputPaths = [];
    this._phaseStart = new Map();
    this._phaseTotal = new Map();
    this._phaseCurrent = new Map();
    this._phaseStatus = new Map();
    this._phaseDurations = new Map();
    this._lastProgressAt = new Map();
    this._warnings = [];
    this._status = "ok";
    this._startTime = Date.now();
    this._progressEmits = 0;
    this._writeQueue = Promise.resolve();
  }

  async _initPaths() {
    if (this.outputPaths.length > 0) return;
    const baseDir = this.outputDir ?? process.env.ASTERIA_OBS_DIR ?? DEFAULT_BASE_DIR;
    const outputDir = path.resolve(baseDir);
    const outputPath = path.join(outputDir, this.tool, `${this.runId}.jsonl`);
    this.outputPaths = [outputPath];
    await ensureDir(path.dirname(outputPath));
  }

  _queueWrite(line) {
    this._writeQueue = this._writeQueue.then(async () => {
      await this._initPaths();
      await Promise.all(this.outputPaths.map((target) => fs.appendFile(target, line, "utf-8")));
    });
  }

  _emit(event) {
    const payload = `${JSON.stringify(event)}\n`;
    this._queueWrite(payload);
  }

  _logEvent(kind, { phase = "", counters, ms, attrs } = {}) {
    const event = {
      eventVersion: "1",
      ts: timestamp(),
      runId: this.runId,
      tool: this.tool,
      phase,
      kind,
      counters,
      ms,
      attrs,
    };
    if (kind === "progress") {
      this._progressEmits += 1;
    }
    this._emit(event);
  }

  phase(name, total) {
    return new PhaseHandle(this, name, total);
  }

  _startPhase(name, total) {
    if (this._phaseStart.has(name)) return;
    this._phaseStart.set(name, Date.now());
    if (total !== undefined && total !== null) {
      this._phaseTotal.set(name, total);
    }
    this._phaseCurrent.set(name, 0);
    this._phaseStatus.set(name, "running");
    this._logEvent("start", {
      phase: name,
      counters: total !== undefined && total !== null ? { current: 0, total } : undefined,
    });
    if (this.enableConsole) {
      console.log(`${timestamp()} [start] ${name}`);
    }
  }

  _setPhase(name, current, total, attrs) {
    const now = Date.now();
    const last = this._lastProgressAt.get(name) ?? 0;
    if (this.minIntervalMs > 0 && now - last < this.minIntervalMs) {
      this._phaseCurrent.set(name, current);
      if (total !== undefined && total !== null) {
        this._phaseTotal.set(name, total);
      }
      return;
    }
    this._lastProgressAt.set(name, now);
    this._phaseCurrent.set(name, current);
    if (total !== undefined && total !== null) {
      this._phaseTotal.set(name, total);
    }
    this._logEvent("progress", {
      phase: name,
      counters: this._maybeCounters(name),
      attrs,
    });
  }

  _tickPhase(name, amount, total, attrs) {
    const current = (this._phaseCurrent.get(name) ?? 0) + amount;
    this._setPhase(name, current, total, attrs);
  }

  _endPhase(name, status) {
    if (!this._phaseStart.has(name)) return;
    const durationMs = Date.now() - (this._phaseStart.get(name) ?? Date.now());
    this._phaseDurations.set(name, durationMs);
    this._phaseStatus.set(name, status);
    if (status === "fail") {
      this._status = "fail";
    } else if (status === "warn" && this._status === "ok") {
      this._status = "warn";
    }
    this._logEvent("end", { phase: name, ms: durationMs, counters: this._maybeCounters(name) });
    if (this.enableConsole) {
      console.log(`${timestamp()} [${status}] ${name} (${formatDuration(durationMs)})`);
    }
  }

  warning(code, message, options = {}) {
    if (this._status === "ok") {
      this._status = "warn";
    }
    const attrs = {
      code,
      message,
      ...(options.attrs ?? {}),
      ...(options.phase ? { phase: options.phase } : {}),
    };
    this._warnings.push(message);
    this._logEvent("warning", { phase: "warning", attrs });
    if (this.enableConsole) {
      console.warn(`${timestamp()} [warn] ${message}`);
    }
  }

  error(code, message, options = {}) {
    this._status = "fail";
    const file = options.file ?? path.join(process.cwd(), "UNKNOWN");
    const line = Number.isFinite(options.line) ? options.line : 0;
    const col = Number.isFinite(options.col) ? options.col : 0;
    process.stderr.write(`ASTERIA_ERROR ${file}:${line}:${col} ${code} ${message}\n`);
    const attrs = {
      code,
      message,
      file,
      line,
      col,
      ...(options.attrs ?? {}),
      ...(options.phase ? { phase: options.phase } : {}),
    };
    this._logEvent("error", { phase: "error", attrs });
  }

  finalize(summary = {}) {
    if (summary.status) {
      this._status = summary.status;
    }
    const totalMs = Date.now() - this._startTime;
    this._logEvent("metric", {
      phase: "summary",
      ms: totalMs,
      attrs: {
        status: this._status,
        phases: Object.fromEntries(this._phaseDurations),
        totals: Object.fromEntries(this._phaseTotal),
        warnings: this._warnings,
        ...summary,
      },
    });
    if (this.enableConsole) {
      console.log("\n----------------------------------------");
      console.log("ASTERIA OBSERVABILITY SUMMARY");
      console.log("----------------------------------------");
      console.log(`  Status: ${this._status.toUpperCase()}`);
      console.log(`  Run ID: ${this.runId}`);
      console.log(`  Duration: ${formatDuration(totalMs)}`);
      console.log(`  JSONL: ${this.outputPaths[0] ?? "n/a"}`);
      if (this._phaseDurations.size > 0) {
        console.log("  Phases:");
        for (const [name, duration] of this._phaseDurations.entries()) {
          const phaseStatus = this._phaseStatus.get(name) ?? "ok";
          console.log(`   - ${name}: ${phaseStatus.toUpperCase()} ${formatDuration(duration)}`);
        }
      }
      console.log("----------------------------------------");
    }
  }

  flush() {
    return this._writeQueue;
  }

  getStats() {
    return { progressEmits: this._progressEmits };
  }

  _maybeCounters(name) {
    const total = this._phaseTotal.get(name);
    const current = this._phaseCurrent.get(name);
    if (total === undefined && current === undefined) return undefined;
    return { current: current ?? 0, total: total ?? 0 };
  }
}

export const createRunReporter = ({
  tool,
  runId,
  outputDir,
  minIntervalMs,
  enableConsole,
} = {}) => {
  if (!tool) {
    throw new Error("createRunReporter requires a tool name");
  }
  const resolvedRunId = runId ?? `${tool}-${Date.now()}`;
  return new RunReporter({
    tool,
    runId: resolvedRunId,
    outputDir,
    minIntervalMs,
    enableConsole,
  });
};
