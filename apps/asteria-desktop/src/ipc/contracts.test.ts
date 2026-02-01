import { describe, expect, it } from "vitest";
import type { IpcChannels, PipelineRunConfig } from "./contracts";

describe("IPC Contracts", () => {
  describe("PipelineRunConfig", () => {
    it("validates required fields", () => {
      const config: PipelineRunConfig = {
        projectId: "proj-1",
        pages: [
          { id: "p1", filename: "page1.png", originalPath: "/input/p1", confidenceScores: {} },
        ],
        targetDpi: 300,
        targetDimensionsMm: { width: 210, height: 297 },
      };

      expect(config.projectId).toBe("proj-1");
      expect(config.pages).toHaveLength(1);
      expect(config.targetDpi).toBe(300);
    });
  });

  describe("IpcChannels", () => {
    it("defines expected method signatures", () => {
      // Type-check: ensure all channel names are valid and types match
      const channelNames: Array<keyof IpcChannels> = [
        "asteria:start-run",
        "asteria:cancel-run",
        "asteria:fetch-page",
        "asteria:apply-override",
        "asteria:export-run",
        "asteria:analyze-corpus",
      ];

      expect(channelNames).toHaveLength(6);
    });
  });
});
