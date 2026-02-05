import { describe, expect, it } from "vitest";
import { ipcErrorToMessage, unwrapIpcResult, unwrapIpcResultOr } from "./ipc.js";

describe("ipc utils", () => {
  it("unwrapIpcResult returns value when ok", () => {
    const result = { ok: true, value: 42 } as const;
    expect(unwrapIpcResult(result)).toBe(42);
  });

  it("unwrapIpcResult throws with context", () => {
    const result = {
      ok: false,
      error: { message: "boom" },
    } as const;
    expect(() => unwrapIpcResult(result, "Load config")).toThrow("Load config: boom");
  });

  it("unwrapIpcResultOr uses fallback", () => {
    const result = { ok: false, error: { message: "boom" } } as const;
    expect(unwrapIpcResultOr(result, "fallback")).toBe("fallback");
  });

  it("unwrapIpcResultOr returns value when ok", () => {
    const result = { ok: true, value: "value" } as const;
    expect(unwrapIpcResultOr(result, "fallback")).toBe("value");
  });

  it("ipcErrorToMessage formats with context", () => {
    const message = ipcErrorToMessage({ message: "oops" }, "Save");
    expect(message).toBe("Save: oops");
  });

  it("ipcErrorToMessage formats without context", () => {
    const message = ipcErrorToMessage({ message: "oops" });
    expect(message).toBe("oops");
  });
});
