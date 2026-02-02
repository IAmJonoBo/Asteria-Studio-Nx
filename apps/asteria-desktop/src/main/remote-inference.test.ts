import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { requestRemoteLayout } from "./remote-inference";

const createTempImage = async (): Promise<string> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-"));
  const filePath = path.join(tempDir, "page.bin");
  await fs.writeFile(filePath, Buffer.alloc(32, 128));
  return filePath;
};

describe("requestRemoteLayout", () => {
  const originalFetch = global.fetch;
  const originalEndpoint = process.env.ASTERIA_REMOTE_LAYOUT_ENDPOINT;
  const originalToken = process.env.ASTERIA_REMOTE_LAYOUT_TOKEN;
  const originalTimeout = process.env.ASTERIA_REMOTE_LAYOUT_TIMEOUT_MS;

  beforeEach(() => {
    process.env.ASTERIA_REMOTE_LAYOUT_ENDPOINT = "https://example.com/layout";
    process.env.ASTERIA_REMOTE_LAYOUT_TOKEN = "test-token";
    process.env.ASTERIA_REMOTE_LAYOUT_TIMEOUT_MS = "250";
  });

  afterEach(() => {
    process.env.ASTERIA_REMOTE_LAYOUT_ENDPOINT = originalEndpoint;
    process.env.ASTERIA_REMOTE_LAYOUT_TOKEN = originalToken;
    process.env.ASTERIA_REMOTE_LAYOUT_TIMEOUT_MS = originalTimeout;
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns null when endpoint responds with error", async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
    const imagePath = await createTempImage();
    const result = await requestRemoteLayout("page-001", imagePath, 1000, 1200);
    expect(result).toBeNull();
  });

  it("maps remote elements to layout elements", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        elements: [{ id: "remote-1", type: "title", bbox: [10, 10, 100, 60], confidence: 0.9 }],
      }),
    }) as unknown as typeof fetch;

    const imagePath = await createTempImage();
    const result = await requestRemoteLayout("page-002", imagePath, 800, 1000);
    expect(result?.length).toBe(1);
    expect(result?.[0].type).toBe("title");
    expect(result?.[0].source).toBe("remote");
  });
});
