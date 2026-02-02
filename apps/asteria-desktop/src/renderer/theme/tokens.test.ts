import { describe, expect, it } from "vitest";
import { tokens } from "./tokens";

describe("tokens", () => {
  it("exposes core design tokens", () => {
    expect(tokens.spacing.md).toBe("12px");
    expect(tokens.typography.fontSize.base).toBe("14px");
    expect(tokens.colors.light.background).toBe("#ffffff");
    expect(tokens.colors.dark.background).toBe("#0f172a");
  });
});
