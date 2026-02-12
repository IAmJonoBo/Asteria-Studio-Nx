import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const sharpCall = vi.hoisted(() => {
  const toBuffer = vi.fn();
  const jpeg = vi.fn(() => ({ toBuffer }));
  const resize = vi.fn(() => ({ jpeg, toBuffer }));
  const sharpFn = vi.fn(() => ({ resize, jpeg, toBuffer }));
  return { sharpFn, resize, jpeg, toBuffer };
});

vi.mock("sharp", () => ({ default: sharpCall.sharpFn }));

import { requestRemoteLayout } from "./remote-inference.js";

const createTempImage = async (): Promise<string> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "asteria-"));
  const filePath = path.join(tempDir, "page.bin");
  await fs.writeFile(filePath, Buffer.alloc(32, 128));
  return filePath;
};

describe("requestRemoteLayout", () => {
  const originalFetch = globalThis.fetch;
  const originalEndpoint = process.env.ASTERIA_REMOTE_LAYOUT_ENDPOINT;
  const originalToken = process.env.ASTERIA_REMOTE_LAYOUT_TOKEN;
  const originalTimeout = process.env.ASTERIA_REMOTE_LAYOUT_TIMEOUT_MS;
  const originalMaxPayload = process.env.ASTERIA_REMOTE_LAYOUT_MAX_PAYLOAD_MB;
  const originalMaxDimension = process.env.ASTERIA_REMOTE_LAYOUT_MAX_DIMENSION_PX;
  const originalYamlToken = process.env.ASTERIA_LAYOUT_TOKEN;

  beforeEach(() => {
    process.env.ASTERIA_REMOTE_LAYOUT_ENDPOINT = "https://example.com/layout";
    process.env.ASTERIA_REMOTE_LAYOUT_TOKEN = "test-token";
    process.env.ASTERIA_REMOTE_LAYOUT_TIMEOUT_MS = "250";
    process.env.ASTERIA_REMOTE_LAYOUT_MAX_PAYLOAD_MB = "8";
    process.env.ASTERIA_REMOTE_LAYOUT_MAX_DIMENSION_PX = "4096";
    sharpCall.sharpFn.mockReset();
    sharpCall.resize.mockReset();
    sharpCall.jpeg.mockReset();
    sharpCall.toBuffer.mockReset();
  });

  afterEach(() => {
    process.env.ASTERIA_REMOTE_LAYOUT_ENDPOINT = originalEndpoint;
    process.env.ASTERIA_REMOTE_LAYOUT_TOKEN = originalToken;
    process.env.ASTERIA_REMOTE_LAYOUT_TIMEOUT_MS = originalTimeout;
    process.env.ASTERIA_REMOTE_LAYOUT_MAX_PAYLOAD_MB = originalMaxPayload;
    process.env.ASTERIA_REMOTE_LAYOUT_MAX_DIMENSION_PX = originalMaxDimension;
    process.env.ASTERIA_LAYOUT_TOKEN = originalYamlToken;
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns null when endpoint responds with error", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false }) as unknown as typeof globalThis.fetch;
    const imagePath = await createTempImage();
    const result = await requestRemoteLayout("page-001", imagePath, 1000, 1200);
    expect(result).toBeNull();
  });

  it("returns null when endpoint is not configured", async () => {
    process.env.ASTERIA_REMOTE_LAYOUT_ENDPOINT = "";
    process.env.ASTERIA_REMOTE_LAYOUT_TOKEN = "";
    process.env.ASTERIA_REMOTE_LAYOUT_TIMEOUT_MS = "";

    const statSpy = vi.spyOn(fs, "stat").mockRejectedValue(new Error("missing"));
    const imagePath = await createTempImage();
    const result = await requestRemoteLayout("page-000", imagePath, 800, 1000);

    expect(result).toBeNull();
    statSpy.mockRestore();
  });

  it("maps remote elements to layout elements", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        elements: [{ id: "remote-1", type: "title", bbox: [10, 10, 100, 60], confidence: 0.9 }],
      }),
    }) as unknown as typeof globalThis.fetch;

    const imagePath = await createTempImage();
    const result = await requestRemoteLayout("page-002", imagePath, 800, 1000);
    expect(result?.length).toBe(1);
    expect(result?.[0].type).toBe("title");
    expect(result?.[0].source).toBe("remote");
  });

  it("uses original payload when within size and dimension limits", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        elements: [{ type: "title", bbox: [1, 1, 10, 10] }],
      }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const imagePath = await createTempImage();
    const result = await requestRemoteLayout("page-009", imagePath, 200, 300);

    expect(result?.length).toBe(1);
    expect(sharpCall.sharpFn).not.toHaveBeenCalled();
    const call = fetchSpy.mock.calls[0] as [string, { body: string }];
    expect(call[1].body).toContain('"imageMime":"image/png"');
  });

  it("clamps bounding boxes and defaults ids/confidence", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        elements: [{ type: "title", bbox: [-10, -10, 5000, 5000], confidence: 2 }],
      }),
    }) as unknown as typeof globalThis.fetch;

    const imagePath = await createTempImage();
    const result = await requestRemoteLayout("page-020", imagePath, 100, 80);

    expect(result?.length).toBe(1);
    expect(result?.[0].id).toBe("page-020-remote-0");
    expect(result?.[0].bbox).toEqual([0, 0, 99, 79]);
    expect(result?.[0].confidence).toBe(1);
  });

  it("returns null when fetch throws", async () => {
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network")) as unknown as typeof globalThis.fetch;

    const imagePath = await createTempImage();
    const result = await requestRemoteLayout("page-021", imagePath, 200, 300);
    expect(result).toBeNull();
  });

  it("uses resized payload when size exceeds max and no token is provided", async () => {
    process.env.ASTERIA_REMOTE_LAYOUT_TOKEN = "";
    process.env.ASTERIA_REMOTE_LAYOUT_MAX_PAYLOAD_MB = "0.000001";
    process.env.ASTERIA_REMOTE_LAYOUT_MAX_DIMENSION_PX = "512";

    sharpCall.toBuffer.mockResolvedValueOnce({
      data: Buffer.alloc(1),
      info: { width: undefined, height: undefined },
    });

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ elements: [{ type: "title", bbox: [0, 0, 10, 10] }] }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const imagePath = await createTempImage();
    const result = await requestRemoteLayout("page-010", imagePath, 800, 1000);

    expect(result?.length).toBe(1);
    const call = fetchSpy.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(call[1].headers.Authorization).toBeUndefined();
    expect(call[1].body).toContain('"imageMime":"image/jpeg"');
  });

  it("loads remote layout config from yaml when env is unset", async () => {
    process.env.ASTERIA_REMOTE_LAYOUT_ENDPOINT = "";
    process.env.ASTERIA_REMOTE_LAYOUT_TOKEN = "";
    process.env.ASTERIA_REMOTE_LAYOUT_TIMEOUT_MS = "";
    process.env.ASTERIA_REMOTE_LAYOUT_MAX_PAYLOAD_MB = "";
    process.env.ASTERIA_REMOTE_LAYOUT_MAX_DIMENSION_PX = "";
    process.env.ASTERIA_LAYOUT_TOKEN = "yaml-token";

    const statSpy = vi.spyOn(fs, "stat").mockResolvedValue({
      isFile: () => true,
      size: 1,
    } as unknown as Awaited<ReturnType<typeof fs.stat>>);
    const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async (target) => {
      const targetPath = String(target);
      if (targetPath.endsWith("pipeline_config.yaml")) {
        return [
          "remote_layout_endpoint: https://example.com/yaml",
          "remote_layout_token_env: ASTERIA_LAYOUT_TOKEN",
          "remote_layout_timeout_ms: 1000",
          "remote_layout_max_payload_mb: 4",
          "remote_layout_max_dimension_px: 512",
        ].join("\n");
      }
      return Buffer.alloc(32, 128);
    });

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ elements: [{ type: "title", bbox: [0, 0, 10, 10] }] }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const imagePath = await createTempImage();
    const result = await requestRemoteLayout("page-011", imagePath, 200, 300);

    expect(result?.length).toBe(1);
    const call = fetchSpy.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(call[0]).toBe("https://example.com/yaml");
    expect(call[1].headers.Authorization).toBe("Bearer yaml-token");

    statSpy.mockRestore();
    readSpy.mockRestore();
  });

  it("returns null when payload exceeds size after resize", async () => {
    process.env.ASTERIA_REMOTE_LAYOUT_MAX_PAYLOAD_MB = "0.000001";

    sharpCall.toBuffer
      .mockResolvedValueOnce({ data: Buffer.alloc(10), info: { width: 500, height: 600 } })
      .mockResolvedValueOnce({ data: Buffer.alloc(10), info: { width: 500, height: 600 } });

    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ elements: [] }) });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const imagePath = await createTempImage();
    const result = await requestRemoteLayout("page-005", imagePath, 5000, 6000);

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("filters out disallowed elements", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        elements: [
          { id: "bad-1", type: "unknown", bbox: [0, 0, 10, 10] },
          { id: "bad-2", type: "title" },
        ],
      }),
    }) as unknown as typeof globalThis.fetch;

    const imagePath = await createTempImage();
    const result = await requestRemoteLayout("page-006", imagePath, 800, 1000);
    expect(result).toBeNull();
  });

  it("returns null when config file cannot be read", async () => {
    process.env.ASTERIA_REMOTE_LAYOUT_ENDPOINT = "";
    process.env.ASTERIA_REMOTE_LAYOUT_TOKEN = "";
    process.env.ASTERIA_REMOTE_LAYOUT_TIMEOUT_MS = "";

    const statSpy = vi
      .spyOn(fs, "stat")
      .mockResolvedValue({ isFile: () => true } as unknown as Awaited<ReturnType<typeof fs.stat>>);
    const readSpy = vi.spyOn(fs, "readFile").mockRejectedValue(new Error("boom"));

    const imagePath = await createTempImage();
    const result = await requestRemoteLayout("page-003", imagePath, 800, 1000);
    expect(result).toBeNull();

    statSpy.mockRestore();
    readSpy.mockRestore();
  });

  it("returns null when no config file is found", async () => {
    process.env.ASTERIA_REMOTE_LAYOUT_ENDPOINT = "";
    process.env.ASTERIA_REMOTE_LAYOUT_TOKEN = "";
    process.env.ASTERIA_REMOTE_LAYOUT_TIMEOUT_MS = "";

    const statSpy = vi.spyOn(fs, "stat").mockRejectedValue(new Error("missing"));

    const imagePath = await createTempImage();
    const result = await requestRemoteLayout("page-004", imagePath, 800, 1000);
    expect(result).toBeNull();

    statSpy.mockRestore();
  });

  it("allows http://localhost for local development", async () => {
    process.env.ASTERIA_REMOTE_LAYOUT_ENDPOINT = "http://localhost:8080/layout";

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        elements: [{ type: "title", bbox: [0, 0, 10, 10], confidence: 0.8 }],
      }),
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const imagePath = await createTempImage();
    const result = await requestRemoteLayout("page-local", imagePath, 200, 300);

    expect(result?.length).toBe(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:8080/layout",
      expect.any(Object)
    );
  });

  it("rejects non-localhost http:// endpoints", async () => {
    process.env.ASTERIA_REMOTE_LAYOUT_ENDPOINT = "http://evil.com/layout";

    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    const imagePath = await createTempImage();
    const result = await requestRemoteLayout("page-evil", imagePath, 200, 300);

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
