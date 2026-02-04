import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnv } from "./config.js";

const makeTempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "asteria-env-"));

describe("loadEnv", () => {
  it("loads .env files, preserves existing values, and parses basics", () => {
    const root = makeTempDir();
    fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "");

    const envPath = path.join(root, ".env");
    fs.writeFileSync(
      envPath,
      [
        "FOO=bar",
        'export BAZ="qux"',
        "WITH_COMMENT=value # comment",
        "QUOTED='hello world'",
        "MULTI=line1\\nline2",
        "EMPTY=",
        "INVALIDLINE",
      ].join("\n")
    );

    const localPath = path.join(root, ".env.local");
    fs.writeFileSync(localPath, "FOO=override\nLOCAL=local");

    const cwd = path.join(root, "apps", "sub");
    fs.mkdirSync(cwd, { recursive: true });

    const env: Record<string, string> = { FOO: "preset" };
    const result = loadEnv({ cwd, env });

    expect(result.loadedFiles).toEqual([envPath, localPath]);
    expect(env.FOO).toBe("preset");
    expect(env.BAZ).toBe("qux");
    expect(env.WITH_COMMENT).toBe("value");
    expect(env.QUOTED).toBe("hello world");
    expect(env.MULTI).toBe("line1\nline2");
    expect(env.EMPTY).toBe("");
    expect(env.LOCAL).toBe("local");
  });

  it("handles missing workspace root and ignores read errors", () => {
    const root = makeTempDir();
    const cwd = path.join(root, "nested");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(path.join(cwd, ".env"));

    const env: Record<string, string> = {};
    const result = loadEnv({ cwd, env });

    expect(result.loadedFiles).toEqual([]);
    expect(Object.keys(env)).toHaveLength(0);
  });
});
