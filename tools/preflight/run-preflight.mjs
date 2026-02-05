#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createRunReporter } from "../observability/nodeReporter.mjs";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const ARTIFACTS_DIR = path.resolve(
  process.env.PREFLIGHT_ARTIFACTS_DIR ?? path.join(ROOT, "artifacts", "preflight")
);
const LOGS_DIR = path.join(ARTIFACTS_DIR, "logs");
const DIFFS_DIR = path.join(ARTIFACTS_DIR, "diffs");
const PIPELINE_RUNNER_PATH = path.join(
  ROOT,
  "apps",
  "asteria-desktop",
  "dist",
  "main",
  "pipeline-runner.js"
);

const ensureDir = async (dir) => {
  await fsp.mkdir(dir, { recursive: true });
};

const writeJson = async (filePath, payload) => {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, JSON.stringify(payload, null, 2));
};

const writeText = async (filePath, content) => {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, content);
};

const exists = async (target) => {
  try {
    await fsp.stat(target);
    return true;
  } catch {
    return false;
  }
};

const runCommand = async ({ id, label, command, args, cwd, env }) => {
  await ensureDir(LOGS_DIR);
  const start = Date.now();
  const stdoutPath = path.join(LOGS_DIR, `${id}.stdout.log`);
  const stderrPath = path.join(LOGS_DIR, `${id}.stderr.log`);

  let stdout = "";
  let stderr = "";

  const outStream = fs.createWriteStream(stdoutPath);
  const errStream = fs.createWriteStream(stderrPath);

  const child = spawn(command, args, {
    cwd: cwd ?? ROOT,
    env: { ...process.env, ...env },
    shell: false,
  });

  let spawnError = null;
  child.on("error", (err) => {
    spawnError = err;
  });

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    outStream.write(text);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    errStream.write(text);
  });

  const exitCode = await new Promise((resolve) => {
    child.on("close", resolve);
  });

  outStream.end();
  errStream.end();

  if (spawnError) {
    stderr += `\\n${spawnError.message}`;
  }

  const durationMs = Date.now() - start;
  const status = exitCode === 0 && !spawnError ? "pass" : "fail";

  return {
    id,
    label,
    command: [command, ...args].join(" "),
    cwd: cwd ?? ROOT,
    status,
    exitCode,
    durationMs,
    stdoutPath,
    stderrPath,
    stdout,
    stderr,
  };
};

const readJson = async (filePath) => {
  const raw = await fsp.readFile(filePath, "utf-8");
  return JSON.parse(raw);
};

const findFilesRecursive = async (rootDir, matcher) => {
  const results = [];
  const entries = await fsp.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findFilesRecursive(full, matcher)));
    } else if (entry.isFile()) {
      if (!matcher || matcher(full)) {
        results.push(full);
      }
    }
  }
  return results;
};

const resolveCorpusPath = async () => {
  const envPath = process.env.PREFLIGHT_CORPUS_DIR;
  if (envPath && (await exists(envPath))) {
    return envPath;
  }

  const candidates = [
    path.join(ROOT, "tests", "fixtures", "golden_corpus", "v1", "inputs"),
    path.join(ROOT, "projects", "mind-myth-and-magick", "input", "raw"),
  ];

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }

  return null;
};

const parseRunId = (stdout) => {
  const match = stdout.match(/Run ID:\s*(\S+)/i);
  return match ? match[1] : null;
};

const gatherVersions = async () => {
  const rootPackage = JSON.parse(await fsp.readFile(path.join(ROOT, "package.json"), "utf-8"));
  const appPackage = JSON.parse(
    await fsp.readFile(path.join(ROOT, "apps", "asteria-desktop", "package.json"), "utf-8")
  );
  const electronVersion =
    appPackage.devDependencies?.electron ?? appPackage.dependencies?.electron ?? "unknown";

  return {
    node: process.version,
    os: `${os.platform()} ${os.release()}`,
    appVersion: appPackage.version ?? rootPackage.version ?? "unknown",
    electron: electronVersion,
  };
};

const gatherGitInfo = async () => {
  try {
    const [commitResult, branchResult] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ROOT }),
      execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT }),
    ]);
    return {
      commit: commitResult.stdout.trim(),
      branch: branchResult.stdout.trim(),
    };
  } catch {
    return { commit: "unknown", branch: "unknown" };
  }
};

const runPreflight = async () => {
  await ensureDir(ARTIFACTS_DIR);
  const runId =
    process.env.ASTERIA_PREFLIGHT_RUN_ID ??
    `preflight-${Date.now()}-${crypto.randomUUID().split("-")[0] ?? "seed"}`;
  const reporter = createRunReporter({
    tool: "preflight",
    runId,
    outputDir: process.env.ASTERIA_OBS_DIR ?? undefined,
  });

  const metadata = {
    generatedAt: new Date().toISOString(),
    versions: await gatherVersions(),
    git: await gatherGitInfo(),
    runId,
  };

  const failures = [];
  const warnings = [];

  const commands = [];
  const isSmoke = process.env.PREFLIGHT_SMOKE === "1";
  const baseCommandSteps = [
    { id: "trunk", label: "Trunk", phase: "trunk", command: "pnpm", args: ["ci:trunk"] },
    {
      id: "lint",
      label: "Lint",
      phase: "lint",
      command: "pnpm",
      args: ["nx", "run", "asteria-desktop:lint"],
    },
    {
      id: "typecheck",
      label: "Typecheck",
      phase: "typecheck",
      command: "pnpm",
      args: ["nx", "run", "asteria-desktop:typecheck"],
    },
    { id: "knip", label: "Knip", phase: "knip", command: "pnpm", args: ["ci:knip"] },
    { id: "ipc-gate", label: "IPC Gate", phase: "ipc", command: "pnpm", args: ["ci:ipc"] },
    { id: "catch-gate", label: "Catch Gate", phase: "catch", command: "pnpm", args: ["ci:catch"] },
    { id: "zip-gate", label: "Zip Gate", phase: "zip", command: "pnpm", args: ["ci:zip"] },
    {
      id: "build-main",
      label: "Build Main",
      phase: "build",
      command: "pnpm",
      args: ["nx", "run", "asteria-desktop:build:main"],
      skipEnv: "PREFLIGHT_SKIP_BUILD",
    },
    {
      id: "test",
      label: "Tests",
      phase: "tests",
      command: "pnpm",
      args: ["nx", "run", "asteria-desktop:test"],
    },
    {
      id: "golden",
      label: "Golden",
      phase: "golden",
      command: "pnpm",
      args: ["nx", "run", "asteria-desktop:golden"],
      skipEnv: "PREFLIGHT_SKIP_GOLDEN",
    },
    {
      id: "e2e",
      label: "E2E",
      phase: "e2e",
      command: "pnpm",
      args: ["nx", "run", "asteria-desktop:e2e"],
      skipEnv: "PREFLIGHT_SKIP_E2E",
    },
  ];
  const commandSteps = isSmoke
    ? [
        {
          id: "smoke",
          label: "Smoke",
          phase: "smoke",
          command: "node",
          args: ["-e", "process.exit(0)"],
        },
      ]
    : baseCommandSteps;

  for (const step of commandSteps) {
    const stepPhase = reporter.phase(step.id, 1);
    stepPhase.start();
    if (step.skipEnv && process.env[step.skipEnv] === "1") {
      commands.push({
        id: step.id,
        label: step.label,
        status: "skipped",
        command: [step.command, ...step.args].join(" "),
      });
      warnings.push(`${step.label} skipped via ${step.skipEnv}`);
      reporter.warning("PREFLIGHT_SKIPPED", `${step.label} skipped via ${step.skipEnv}`, {
        phase: step.id,
      });
      stepPhase.end("warn", "skipped");
      continue;
    }

    const result = await runCommand({
      id: step.id,
      label: step.label,
      command: step.command,
      args: step.args,
    });
    commands.push(result);
    stepPhase.set(1, 1, { command: result.command, exitCode: result.exitCode });
    if (result.status === "fail") {
      failures.push(`${step.label} failed`);
      reporter.error("PREFLIGHT_COMMAND_FAILED", `${step.label} failed`, {
        phase: step.id,
        file: result.stderrPath,
        line: 1,
        col: 0,
        attrs: { command: result.command, exitCode: result.exitCode },
      });
      if (step.id === "golden") {
        const goldenArtifacts = path.join(ROOT, ".golden-artifacts");
        if (await exists(goldenArtifacts)) {
          await ensureDir(DIFFS_DIR);
          await fsp.cp(goldenArtifacts, DIFFS_DIR, { recursive: true });
        }
      }
      stepPhase.end("fail");
    } else {
      stepPhase.end("ok");
    }
  }

  const determinism = {
    status: "skipped",
    runs: [],
    forbiddenPaths: [],
    leftoverTmpFiles: [],
  };

  if (process.env.PREFLIGHT_SKIP_PIPELINE !== "1" && !isSmoke) {
    const tripwirePhase = reporter.phase("tripwires", 2);
    tripwirePhase.start();
    const corpusPath = await resolveCorpusPath();
    if (!corpusPath) {
      warnings.push("Determinism run skipped (no corpus found)");
      reporter.warning("PREFLIGHT_SKIP_PIPELINE", "Determinism run skipped (no corpus found)", {
        phase: "tripwires",
      });
      tripwirePhase.end("warn", "no corpus");
    } else if (!(await exists(PIPELINE_RUNNER_PATH))) {
      determinism.status = "fail";
      failures.push("Determinism run failed (missing build output)");
      reporter.error(
        "PREFLIGHT_PIPELINE_BUILD_MISSING",
        "Determinism run failed (missing build output)",
        {
          phase: "tripwires",
          file: PIPELINE_RUNNER_PATH,
          line: 1,
          col: 0,
        }
      );
      tripwirePhase.end("fail");
    } else {
      const sampleCount = process.env.PREFLIGHT_SAMPLE_COUNT || "2";
      const outputDir = process.env.ASTERIA_OUTPUT_DIR ?? path.join(ROOT, "pipeline-results");

      const runOutputs = [];
      for (let idx = 0; idx < 2; idx += 1) {
        const runResult = await runCommand({
          id: `pipeline-run-${idx + 1}`,
          label: `Pipeline Run ${idx + 1}`,
          command: "node",
          args: [
            path.join(ROOT, "tools", "preflight", "run-pipeline.mjs"),
            corpusPath,
            sampleCount,
          ],
        });

        tripwirePhase.tick(1, { runIndex: idx + 1 });
        if (runResult.status === "fail") {
          reporter.error("PREFLIGHT_PIPELINE_RUN_FAILED", `Pipeline run ${idx + 1} failed`, {
            phase: "tripwires",
            file: runResult.stderrPath,
            line: 1,
            col: 0,
          });
        }

        const runId = parseRunId(runResult.stdout);
        const runDir = runId ? path.join(outputDir, "runs", runId) : null;
        const requiredFiles = runDir
          ? [
              path.join(runDir, "manifest.json"),
              path.join(runDir, "report.json"),
              path.join(runDir, "review-queue.json"),
            ]
          : [];
        const requiredDirs = runDir
          ? [path.join(runDir, "normalized"), path.join(runDir, "sidecars")]
          : [];

        const runChecks = {
          runId,
          runDir,
          status: runResult.status,
          requiredFiles: [],
          requiredDirs: [],
          jsonParse: [],
          tmpFiles: [],
        };

        if (!runId || !runDir || !(await exists(runDir))) {
          runChecks.status = "fail";
        } else {
          for (const filePath of requiredFiles) {
            const ok = await exists(filePath);
            runChecks.requiredFiles.push({ path: filePath, ok });
            if (!ok) runChecks.status = "fail";
          }
          for (const dirPath of requiredDirs) {
            const ok = await exists(dirPath);
            runChecks.requiredDirs.push({ path: dirPath, ok });
            if (!ok) runChecks.status = "fail";
          }

          for (const filePath of requiredFiles) {
            if (await exists(filePath)) {
              try {
                await readJson(filePath);
                runChecks.jsonParse.push({ path: filePath, ok: true });
              } catch {
                runChecks.jsonParse.push({ path: filePath, ok: false });
                runChecks.status = "fail";
              }
            }
          }

          const tmpFiles = await findFilesRecursive(runDir, (file) => file.endsWith(".tmp"));
          runChecks.tmpFiles = tmpFiles;
          if (tmpFiles.length > 0) {
            runChecks.status = "fail";
          }
        }

        runOutputs.push({
          command: runResult,
          checks: runChecks,
        });
      }

      const forbidden = ["normalized", "previews", "sidecars", "overlays"].filter((name) =>
        fs.existsSync(path.join(outputDir, name))
      );

      determinism.status = runOutputs.every((entry) => entry.checks.status === "pass")
        ? "pass"
        : "fail";
      determinism.runs = runOutputs;
      determinism.forbiddenPaths = forbidden.map((name) => path.join(outputDir, name));
      determinism.leftoverTmpFiles = runOutputs.flatMap((entry) => entry.checks.tmpFiles ?? []);

      if (forbidden.length > 0) {
        determinism.status = "fail";
      }

      const runIds = runOutputs.map((entry) => entry.checks.runId).filter(Boolean);
      if (new Set(runIds).size !== runIds.length) {
        determinism.status = "fail";
        failures.push("Determinism run IDs collided");
      }

      if (determinism.status === "fail") {
        failures.push("Determinism tripwire checks failed");
        reporter.error("PREFLIGHT_TRIPWIRE_FAILED", "Determinism tripwire checks failed", {
          phase: "tripwires",
          file: path.join(ARTIFACTS_DIR, "preflight-report.json"),
          line: 1,
          col: 0,
        });
        tripwirePhase.end("fail");
      } else {
        tripwirePhase.end("ok");
      }
    }
  } else {
    const reason = isSmoke ? "PREFLIGHT_SMOKE" : "PREFLIGHT_SKIP_PIPELINE";
    warnings.push(`Determinism run skipped via ${reason}`);
    reporter.warning("PREFLIGHT_SKIP_PIPELINE", `Determinism run skipped via ${reason}`, {
      phase: "tripwires",
    });
  }

  const exportSanity = {
    status: "skipped",
    runId: null,
    runDir: null,
    requiredFiles: [],
    requiredDirs: [],
  };

  if (determinism.status === "pass" && determinism.runs.length > 0) {
    const exportPhase = reporter.phase("export-sanity", 1);
    exportPhase.start();
    const lastRun = determinism.runs[determinism.runs.length - 1]?.checks;
    exportSanity.runId = lastRun?.runId ?? null;
    exportSanity.runDir = lastRun?.runDir ?? null;

    if (exportSanity.runDir) {
      const requiredFiles = [
        path.join(exportSanity.runDir, "manifest.json"),
        path.join(exportSanity.runDir, "report.json"),
        path.join(exportSanity.runDir, "review-queue.json"),
      ];
      const requiredDirs = [
        path.join(exportSanity.runDir, "normalized"),
        path.join(exportSanity.runDir, "sidecars"),
      ];

      for (const filePath of requiredFiles) {
        const ok = await exists(filePath);
        exportSanity.requiredFiles.push({ path: filePath, ok });
      }
      for (const dirPath of requiredDirs) {
        const ok = await exists(dirPath);
        exportSanity.requiredDirs.push({ path: dirPath, ok });
      }

      exportSanity.status =
        exportSanity.requiredFiles.every((entry) => entry.ok) &&
        exportSanity.requiredDirs.every((entry) => entry.ok)
          ? "pass"
          : "fail";

      if (exportSanity.status === "fail") {
        failures.push("Export sanity check failed");
        reporter.error("PREFLIGHT_EXPORT_SANITY_FAILED", "Export sanity check failed", {
          phase: "export-sanity",
          file: path.join(exportSanity.runDir, "manifest.json"),
          line: 1,
          col: 0,
        });
        exportPhase.end("fail");
      } else {
        exportPhase.end("ok");
      }
    }
  }

  const performance = {
    status: "n/a",
    thresholdMs: 120000,
    samples: [],
  };

  const pipelineRuns = determinism.runs ?? [];
  if (pipelineRuns.length > 0) {
    const performancePhase = reporter.phase("performance-smoke", pipelineRuns.length);
    performancePhase.start();
    performance.status = "pass";
    for (const entry of pipelineRuns) {
      const durationMs = entry.command?.durationMs ?? 0;
      const runId = entry.checks?.runId ?? "unknown";
      const throughputMatch = entry.command?.stdout?.match(/Throughput:\s*([\d.]+)\s*pages\/sec/i);
      const throughput = throughputMatch ? Number.parseFloat(throughputMatch[1]) : null;
      performance.samples.push({ runId, durationMs, throughput });
      performancePhase.tick(1, { runId, durationMs, throughput });
      if (durationMs > performance.thresholdMs) {
        performance.status = "warn";
      }
    }
    if (performance.status === "warn") {
      warnings.push("Performance smoke exceeded threshold; review pipeline throughput");
      reporter.warning(
        "PREFLIGHT_PERFORMANCE_WARN",
        "Performance smoke exceeded threshold; review pipeline throughput",
        { phase: "performance-smoke" }
      );
    }
    performancePhase.end(performance.status === "warn" ? "warn" : "ok");
  }

  const summaryStatus = failures.length > 0 ? "fail" : "pass";

  const report = {
    metadata,
    commands,
    determinism,
    exportSanity,
    performance,
    warnings,
    failures,
    summary: {
      status: summaryStatus,
      releaseReady: summaryStatus === "pass",
    },
  };

  const reportJsonPath = path.join(ARTIFACTS_DIR, "preflight-report.json");
  await writeJson(reportJsonPath, report);

  const renderList = (items) =>
    items.length === 0 ? "- none" : items.map((item) => `- ${item}`).join("\n");

  const commandRows = commands
    .map(
      (step) =>
        `| ${step.label ?? step.id} | ${step.status} | ${step.durationMs ?? "-"} | ${step.command} | ${step.stdoutPath ?? ""} |`
    )
    .join("\n");

  const markdown = `# Asteria Studio Preflight Report\n\nGenerated: ${metadata.generatedAt}\n\n## Summary\n- Status: ${summaryStatus.toUpperCase()}\n- Release Ready: ${summaryStatus === "pass" ? "yes" : "no"}\n\n## Environment\n- Node: ${metadata.versions.node}\n- OS: ${metadata.versions.os}\n- App Version: ${metadata.versions.appVersion}\n- Electron: ${metadata.versions.electron}\n- Git Commit: ${metadata.git.commit}\n- Git Branch: ${metadata.git.branch}\n\n## Command Results\n| Step | Status | Duration (ms) | Command | Stdout Log |\n| --- | --- | --- | --- | --- |\n${commandRows}\n\n## Determinism Tripwire\n- Status: ${determinism.status}\n- Forbidden Paths: ${determinism.forbiddenPaths.length > 0 ? determinism.forbiddenPaths.join(", ") : "none"}\n- Leftover Temp Files: ${determinism.leftoverTmpFiles.length > 0 ? determinism.leftoverTmpFiles.join(", ") : "none"}\n\n## Export Sanity\n- Status: ${exportSanity.status}\n- Run ID: ${exportSanity.runId ?? "n/a"}\n- Run Dir: ${exportSanity.runDir ?? "n/a"}\n\n## Performance Smoke\n- Status: ${performance.status}\n- Threshold: ${performance.thresholdMs} ms\n${performance.samples
    .map(
      (sample) =>
        `- ${sample.runId}: ${sample.durationMs} ms${sample.throughput ? `, ${sample.throughput} pages/sec` : ""}`
    )
    .join(
      "\n"
    )}\n\n## Warnings\n${renderList(warnings)}\n\n## Failures\n${renderList(failures)}\n\n## Manual Checklist\n- Review ${path.relative(ROOT, path.join(ROOT, "PRELAUNCH_CHECKLIST.md"))} before release.\n`;

  const reportMdPath = path.join(ARTIFACTS_DIR, "preflight-report.md");
  await writeText(reportMdPath, markdown);

  reporter.finalize({
    status: summaryStatus === "pass" ? "ok" : "fail",
    outputPaths: [reportJsonPath, reportMdPath],
  });
  await reporter.flush();

  if (summaryStatus === "fail") {
    process.exit(1);
  }
};

await runPreflight();
