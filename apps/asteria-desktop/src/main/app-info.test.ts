import { beforeEach, describe, expect, it, vi } from "vitest";

const getVersion = vi.hoisted(() => vi.fn(() => "1.2.3"));
vi.mock("electron", () => ({ app: { getVersion } }));

import { getAppInfo } from "./app-info.js";

describe("app-info", () => {
  const env = { ...process.env };

  beforeEach(() => {
    process.env = { ...env };
    getVersion.mockClear();
    delete process.env.ASTERIA_BUILD_HASH;
    delete process.env.ASTERIA_COMMIT;
    delete process.env.VITE_BUILD_HASH;
    delete process.env.VITE_COMMIT;
    delete process.env.BUILD_HASH;
    delete process.env.COMMIT_SHA;
    delete process.env.GITHUB_SHA;
  });

  it("returns version and platform with overrides", () => {
    process.env.ASTERIA_BUILD_HASH = "build-123";
    process.env.ASTERIA_COMMIT = "commit-456";

    const info = getAppInfo();

    expect(info.version).toBe("1.2.3");
    expect(info.buildHash).toBe("build-123");
    expect(info.commit).toBe("commit-456");
    expect(info.platform).toBe(process.platform);
  });

  it("returns undefined build metadata when unset", () => {
    const info = getAppInfo();

    expect(info.buildHash).toBeUndefined();
    expect(info.commit).toBeUndefined();
  });
});
