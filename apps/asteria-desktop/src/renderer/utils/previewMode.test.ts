import { describe, expect, it } from "vitest";
import { isUiPreviewModeEnabled } from "./previewMode.js";

describe("isUiPreviewModeEnabled", () => {
  it("enables preview mode when uiPreview=1", () => {
    expect(isUiPreviewModeEnabled("?uiPreview=1")).toBe(true);
  });

  it("enables preview mode when uiPreview=true", () => {
    expect(isUiPreviewModeEnabled("?uiPreview=true")).toBe(true);
  });

  it("disables preview mode when uiPreview=false", () => {
    expect(isUiPreviewModeEnabled("?uiPreview=false")).toBe(false);
  });

  it("disables preview mode when no query string is present", () => {
    expect(isUiPreviewModeEnabled("")).toBe(false);
  });

  it("returns false when query parsing throws", () => {
    const original = globalThis.URLSearchParams;
    Object.defineProperty(globalThis, "URLSearchParams", {
      configurable: true,
      value: class BrokenSearchParams {
        constructor() {
          throw new Error("bad query");
        }
      },
    });

    expect(isUiPreviewModeEnabled("%E0%A4%A")).toBe(false);

    Object.defineProperty(globalThis, "URLSearchParams", {
      configurable: true,
      value: original,
    });
  });

  it("reads from global location by default", () => {
    const originalLocation = globalThis.location;
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { search: "?uiPreview=1" },
    });

    expect(isUiPreviewModeEnabled()).toBe(true);

    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: originalLocation,
    });
  });
});
