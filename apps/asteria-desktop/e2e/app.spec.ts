import { test, expect } from "@playwright/test";

test.describe("Asteria Desktop App", () => {
  test("app opens and shows navigation", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });

    const nav = page.getByRole("navigation", { name: /main navigation/i });
    await expect(nav).toBeVisible();
    await expect(nav.getByRole("button", { name: /projects/i }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /projects/i }).first()).toBeVisible();
  });

  test("command palette opens with keyboard", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });

    await page.keyboard.press("Control+K");
    await expect(page.getByRole("dialog", { name: /command palette/i })).toBeVisible();
    await expect(page.getByRole("textbox", { name: /command search/i })).toBeVisible();
  });

  test("review queue screen is reachable", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });

    await page
      .getByRole("button", { name: /review queue/i })
      .first()
      .click();
    await expect(page.getByRole("heading", { name: /select a run to review/i })).toBeVisible();
  });

  test("review queue loads and submits review", async ({ page }) => {
    await page.addInitScript(() => {
      const globalRef = globalThis as typeof globalThis & {
        asteria?: {
          ipc?: Record<string, unknown>;
          onRunProgress?: () => () => void;
          ping?: () => string;
        };
        __submitted?: { runId: string; decisions: Array<{ pageId: string; decision: string }> };
      };
      const noop = () => undefined;
      globalRef.__submitted = undefined;
      globalRef.asteria = {
        ipc: {
          "asteria:list-projects": async () => [],
          "asteria:list-runs": async () => [
            {
              runId: "run-1",
              runDir: "/tmp/runs/run-1",
              projectId: "project-1",
              generatedAt: "2026-02-02",
              reviewCount: 1,
            },
          ],
          "asteria:fetch-review-queue": async (_runId: string, _runDir: string) => ({
            runId: "run-1",
            projectId: "project-1",
            generatedAt: "2026-02-02",
            items: [
              {
                pageId: "page-1",
                filename: "page-1.png",
                layoutProfile: "body",
                layoutConfidence: 0.72,
                qualityGate: { accepted: false, reasons: ["low-mask-coverage"] },
                reason: "quality-gate",
                previews: [
                  { kind: "normalized", path: "/tmp/page-1.png", width: 100, height: 140 },
                ],
                suggestedAction: "adjust",
              },
            ],
          }),
          "asteria:submit-review": async (
            _runId: string,
            _runDir: string,
            decisions: Array<{ pageId: string; decision: string }>
          ) => {
            globalRef.__submitted = { runId: "run-1", decisions };
          },
        },
        onRunProgress: () => noop,
        ping: () => "pong",
      };
    });

    await page.goto("/", { waitUntil: "networkidle" });

    await page
      .getByRole("button", { name: /run history/i })
      .first()
      .click();
    await page
      .getByRole("button", { name: /open review queue/i })
      .first()
      .click();

    await expect(page.getByText(/why flagged/i)).toBeVisible();

    await page.getByRole("button", { name: /accept page/i }).click();
    await page.getByRole("button", { name: /submit review/i }).click();

    await page.waitForFunction(() => {
      const globalRef = globalThis as typeof globalThis & {
        __submitted?: { decisions?: Array<{ pageId: string; decision: string }> };
      };
      return Boolean(globalRef.__submitted?.decisions?.length);
    });
  });

  test("review queue toggles overlays and applies baseline edits", async ({ page }) => {
    await page.addInitScript(() => {
      const globalRef = globalThis as typeof globalThis & {
        asteria?: {
          ipc?: Record<string, unknown>;
          onRunProgress?: () => () => void;
          ping?: () => string;
        };
        __overrideApplied?: { runId: string; pageId: string; overrides: unknown };
      };
      const noop = () => undefined;
      globalRef.__overrideApplied = undefined;
      globalRef.asteria = {
        ipc: {
          "asteria:list-projects": async () => [],
          "asteria:list-runs": async () => [
            {
              runId: "run-1",
              runDir: "/tmp/runs/run-1",
              projectId: "project-1",
              generatedAt: "2026-02-02",
              reviewCount: 1,
            },
          ],
          "asteria:fetch-review-queue": async () => ({
            runId: "run-1",
            projectId: "project-1",
            generatedAt: "2026-02-02",
            items: [
              {
                pageId: "page-1",
                filename: "page-1.png",
                layoutProfile: "body",
                layoutConfidence: 0.72,
                qualityGate: { accepted: false, reasons: ["low-mask-coverage"] },
                reason: "quality-gate",
                previews: [
                  {
                    kind: "normalized",
                    path: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6fYdS0AAAAASUVORK5CYII=",
                    width: 100,
                    height: 100,
                  },
                ],
                suggestedAction: "adjust",
              },
            ],
          }),
          "asteria:fetch-sidecar": async () => ({
            pageId: "page-1",
            dpi: 300,
            normalization: {
              cropBox: [0, 0, 99, 99],
              pageMask: [0, 0, 99, 99],
              trim: 0,
            },
            elements: [],
          }),
          "asteria:apply-override": async (_runId: string, _pageId: string, overrides: unknown) => {
            globalRef.__overrideApplied = { runId: "run-1", pageId: "page-1", overrides };
          },
        },
        onRunProgress: () => noop,
        ping: () => "pong",
      };
    });

    await page.goto("/", { waitUntil: "networkidle" });

    await page
      .getByRole("button", { name: /run history/i })
      .first()
      .click();
    await page
      .getByRole("button", { name: /open review queue/i })
      .first()
      .click();

    const overlaysButton = page.getByRole("button", { name: /overlays/i });
    await expect(overlaysButton).toBeVisible();
    await overlaysButton.click();
    await expect(overlaysButton).toHaveText(/Show Overlays|Hide Overlays/);

    await page.getByRole("button", { name: /⟳/ }).click();
    await page.getByRole("button", { name: /apply override/i }).first().click();

    await page.waitForFunction(() => {
      const globalRef = globalThis as typeof globalThis & {
        __overrideApplied?: { overrides?: unknown };
      };
      return Boolean(globalRef.__overrideApplied?.overrides);
    });
  });
});
