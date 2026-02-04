import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createNullLogger, createRunLogger } from "./logger.js";
import { getRunLogDir } from "./run-paths.js";

const waitForWrites = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 25));

describe("run logger", () => {
  it("writes run and page logs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-log-"));
    const runDir = path.join(tempDir, "runs", "run-1");
    await fs.mkdir(runDir, { recursive: true });

    const logger = createRunLogger(runDir, {
      level: "info",
      per_page_logs: true,
      keep_logs: true,
    });
    logger.info("run-start", { runId: "run-1" });
    logger.page("page-1", "warn", "page-issue", { detail: "low-contrast" });

    await waitForWrites();

    const logDir = getRunLogDir(runDir);
    const runLog = await fs.readFile(path.join(logDir, "run.log"), "utf-8");
    const pageLog = await fs.readFile(path.join(logDir, "pages", "page-1.log"), "utf-8");

    expect(runLog).toContain("run-start");
    expect(pageLog).toContain("page-issue");
  });

  it("removes logs when keep_logs is false", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-log-"));
    const runDir = path.join(tempDir, "runs", "run-2");
    await fs.mkdir(runDir, { recursive: true });

    const logger = createRunLogger(runDir, { keep_logs: false });
    logger.info("run-start", { runId: "run-2" });

    await waitForWrites();
    await logger.finalize();

    await expect(fs.stat(getRunLogDir(runDir))).rejects.toBeDefined();
  });

  it("respects log levels and disables per-page logs", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-log-"));
    const runDir = path.join(tempDir, "runs", "run-3");
    await fs.mkdir(runDir, { recursive: true });

    const logger = createRunLogger(runDir, { level: "error", per_page_logs: false });
    logger.info("ignored", { runId: "run-3" });
    logger.page("page-1", "info", "ignored-page");

    await waitForWrites();

    await expect(fs.stat(path.join(getRunLogDir(runDir), "run.log"))).rejects.toBeDefined();
    await expect(fs.stat(path.join(getRunLogDir(runDir), "pages"))).rejects.toBeDefined();
  });

  it("creates a null logger that no-ops", async () => {
    const logger = createNullLogger();
    logger.debug("noop");
    logger.info("noop");
    logger.warn("noop");
    logger.error("noop");
    logger.page("page-1", "info", "noop");
    await logger.finalize();
  });
});
