#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const QUARANTINE_DOC = "docs/dead_code_quarantine.md";
const LEGACY_PATTERN = /(legacy|quarantin(?:e|ed))/i;
const PLACEHOLDER_PATTERN = /(example|placeholder)/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const workspaceRoot = process.cwd();
const quarantineDocPath = path.join(workspaceRoot, QUARANTINE_DOC);

const getTrackedFiles = () => {
  const output = execFileSync("git", ["ls-files"], { cwd: workspaceRoot, encoding: "utf8" });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
};

const parseRegisterRows = (doc) => {
  const lines = doc.split("\n");
  const rows = [];
  let inRegister = false;

  for (const line of lines) {
    if (line.startsWith("## Quarantine Register")) {
      inRegister = true;
      continue;
    }
    if (inRegister && line.startsWith("## ")) {
      break;
    }
    if (!inRegister) continue;

    if (!line.trim().startsWith("|")) continue;

    const cells = line
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());

    if (cells.length !== 6) continue;

    const [item, location, reason, trackingIssue, targetRemoval, owner] = cells;

    if (item.toLowerCase() === "item" || item.startsWith("---")) {
      continue;
    }

    rows.push({ item, location, reason, trackingIssue, targetRemoval, owner, source: line });
  }

  return rows;
};

const legacyPaths = getTrackedFiles().filter(
  (file) => file !== QUARANTINE_DOC && LEGACY_PATTERN.test(file)
);

const quarantineDoc = readFileSync(quarantineDocPath, "utf8");
const registerRows = parseRegisterRows(quarantineDoc);

const failures = [];

for (const row of registerRows) {
  if (PLACEHOLDER_PATTERN.test(row.item)) {
    failures.push(`Placeholder row is not allowed in quarantine register: ${row.source}`);
  }
  if (!row.owner || row.owner === "-") {
    failures.push(`Missing owner for quarantine row: ${row.source}`);
  }
  if (!DATE_PATTERN.test(row.targetRemoval)) {
    failures.push(
      `Target Removal must be an ISO date (YYYY-MM-DD) for row: ${row.source}`
    );
  }
}

for (const legacyPath of legacyPaths) {
  const hasRow = registerRows.some((row) => row.location === legacyPath);
  if (!hasRow) {
    failures.push(
      `Missing quarantine register row for legacy/quarantined path: ${legacyPath}`
    );
  }
}

if (failures.length > 0) {
  console.error("Dead-code quarantine check failed:\n");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Dead-code quarantine check passed.");
