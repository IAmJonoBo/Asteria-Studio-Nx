import { test, expect } from "@playwright/test";

test.describe("Asteria Desktop App", () => {
  test("app opens and renders headline", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });

    // Verify hero headline
    const headline = page.getByRole("heading", { name: /enterprise page normalization/i });
    await expect(headline).toBeVisible();
  });

  test("pipeline highlights section is visible", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });

    const section = page.getByRole("heading", { name: /pipeline highlights/i });
    await expect(section).toBeVisible();

    // Check that at least one highlight item is visible
    const items = page.locator("li");
    await expect(items.first()).toContainText(/deskew|dewarp|detect/i);
  });

  test("next-up section offers context", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });

    const nextUp = page.getByText(/Hook up IPC to the orchestrator/i);
    await expect(nextUp).toBeVisible();
  });
});
