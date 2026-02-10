import { test, expect, type Page } from "@playwright/test";

const tinyPng =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAQAAABKJx4PAAAAE0lEQVR42u3BAQ0AAADCIPunNsN+YAAAAAAAAAA4G4MFAAG3hiy9AAAAAElFTkSuQmCC";

const installReviewPaneFixture = async (page: Page): Promise<void> => {
  await page.addInitScript(() => {
    const globalRef = globalThis as typeof globalThis & {
      asteria?: {
        ipc?: Record<string, unknown>;
        onRunProgress?: () => () => void;
        ping?: () => string;
      };
      __overrideApplied?: unknown;
    };

    const ok = <T>(value: T) => ({ ok: true, value });
    const noop = () => undefined;

    globalRef.__overrideApplied = undefined;

    globalRef.asteria = {
      ipc: {
        "asteria:list-projects": async () => ok([]),
        "asteria:list-runs": async () =>
          ok([
            {
              runId: "fixture-run-1",
              runDir: "/tmp/runs/fixture-run-1",
              projectId: "project-1",
              generatedAt: "2026-02-02",
              reviewCount: 2,
            },
          ]),
        "asteria:fetch-review-queue": async () =>
          ok({
            runId: "fixture-run-1",
            projectId: "project-1",
            generatedAt: "2026-02-02",
            items: [
              {
                pageId: "page-1",
                filename: "page-1.png",
                layoutProfile: "body",
                layoutConfidence: 0.9,
                qualityGate: { accepted: false, reasons: ["low-mask-coverage"] },
                reason: "quality-gate",
                previews: [{ kind: "normalized", path: "__TINY__", width: 100, height: 100 }],
              },
            ],
          }),
        "asteria:fetch-sidecar": async () =>
          ok({
            pageId: "page-1",
            dpi: 300,
            normalization: { cropBox: [0, 0, 99, 99], pageMask: [0, 0, 99, 99], trim: 0 },
            elements: [{ id: "text", type: "text_block", bbox: [30, 20, 80, 80], confidence: 0.95 }],
            guides: {
              layers: [
                {
                  id: "rulers",
                  guides: [{ id: "r-1", axis: "x", position: 10, kind: "major", label: "Ruler" }],
                },
                {
                  id: "margin-guides",
                  guides: [{ id: "m-1", axis: "x", position: 20, kind: "major", label: "Margin" }],
                },
              ],
            },
          }),
        "asteria:apply-override": async (_runId: string, _pageId: string, overrides: unknown) => {
          globalRef.__overrideApplied = overrides;
          return ok(undefined);
        },
      },
      onRunProgress: () => noop,
      ping: () => "pong",
    };
  });

  await page.addInitScript((image) => {
    const globalRef = globalThis as typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } };
    const originalFetchQueue = globalRef.asteria?.ipc?.["asteria:fetch-review-queue"] as
      | (() => Promise<{ ok: true; value: { items: Array<{ previews: Array<{ path: string }> }> } }>)
      | undefined;
    if (!originalFetchQueue || !globalRef.asteria?.ipc) return;
    globalRef.asteria.ipc["asteria:fetch-review-queue"] = async () => {
      const result = await originalFetchQueue();
      if (!result.ok) return result;
      result.value.items.forEach((item) => {
        item.previews.forEach((preview) => {
          if (preview.path === "__TINY__") preview.path = image;
        });
      });
      return result;
    };
  }, tinyPng);
};

const assertReviewPaneReadyChecklist = async (page: Page): Promise<void> => {
  await expect(page.getByAltText(/normalized preview for page-1\.png/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /crop handles/i })).toBeEnabled();
  await expect(page.locator("[data-guide-layer]").first()).toBeVisible();
  await page.waitForFunction(() => {
    const globalRef = globalThis as typeof globalThis & { __overrideApplied?: unknown };
    return Boolean(globalRef.__overrideApplied);
  });
};

test("review pane fixture validates preview, guides, and snapping", async ({ page }) => {
  await installReviewPaneFixture(page);

  await page.goto("/", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /run history/i }).first().click();
  await page.getByRole("button", { name: /open review queue/i }).first().click();

  await expect(page.getByAltText(/normalized preview for page-1\.png/i)).toBeVisible();

  const rulers = page.getByRole("checkbox", { name: /rulers guide layer/i });
  const margins = page.getByRole("checkbox", { name: /margins guide layer/i });
  await expect(rulers).toBeChecked();
  await expect(margins).toBeChecked();
  await rulers.uncheck();
  await margins.uncheck();
  await expect(page.locator('[data-guide-layer="rulers"]')).toHaveCount(0);
  await expect(page.locator('[data-guide-layer="margin-guides"]')).toHaveCount(0);
  await rulers.check();
  await margins.check();

  await page.getByRole("button", { name: /crop handles/i }).click();
  const rightHandle = page.locator('circle[aria-label="Drag to adjust right edge of crop box"]').first();
  await rightHandle.dispatchEvent("pointerdown", { pointerId: 1, clientX: 99, clientY: 50 });
  await page.dispatchEvent("body", "pointermove", { pointerId: 1, clientX: 79, clientY: 50 });
  await page.dispatchEvent("body", "pointerup", { pointerId: 1 });

  await page.getByRole("button", { name: /apply override/i }).first().click();

  await assertReviewPaneReadyChecklist(page);
});
