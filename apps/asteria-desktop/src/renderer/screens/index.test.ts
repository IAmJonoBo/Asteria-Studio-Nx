import { describe, expect, it } from "vitest";
import {
  ExportsScreen,
  MonitorScreen,
  ProjectsScreen,
  ReviewQueueScreen,
  RunsScreen,
  SettingsScreen,
} from "./index";

describe("screens index", () => {
  it("exports screens", () => {
    expect(typeof ProjectsScreen).toBe("function");
    expect(typeof ReviewQueueScreen).toBe("function");
    expect(typeof RunsScreen).toBe("function");
    expect(typeof MonitorScreen).toBe("function");
    expect(typeof ExportsScreen).toBe("function");
    expect(typeof SettingsScreen).toBe("function");
  });
});
