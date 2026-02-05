import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());
const setAboutPanelOptions = vi.hoisted(() => vi.fn());
const setApplicationMenu = vi.hoisted(() => vi.fn());
const buildFromTemplate = vi.hoisted(() => vi.fn((template) => ({ template })));
const getFocusedWindow = vi.hoisted(() => vi.fn());
const getAllWindows = vi.hoisted(() => vi.fn());
const getName = vi.hoisted(() => vi.fn(() => "Asteria Studio"));

vi.mock("electron", () => ({
  app: { getName, setAboutPanelOptions },
  BrowserWindow: { getFocusedWindow, getAllWindows },
  Menu: { buildFromTemplate, setApplicationMenu },
}));

vi.mock("./app-info", () => ({
  getAppInfo: () => ({ version: "1.0.0", buildHash: "build", platform: "darwin" }),
}));

import { buildAppMenu } from "./menu.js";

type MenuItem = {
  label?: string;
  submenu?: MenuItem[];
  click?: () => void;
};

describe("menu", () => {
  beforeEach(() => {
    send.mockReset();
    setAboutPanelOptions.mockReset();
    setApplicationMenu.mockReset();
    buildFromTemplate.mockClear();
    getFocusedWindow.mockReset();
    getAllWindows.mockReset();

    const window = { webContents: { send } };
    getFocusedWindow.mockReturnValue(window);
    getAllWindows.mockReturnValue([window]);
  });

  const findMenuItem = (template: MenuItem[], label: string): MenuItem | undefined => {
    for (const item of template) {
      if (item.label === label) return item;
      if (Array.isArray(item.submenu)) {
        const match = findMenuItem(item.submenu, label);
        if (match) return match;
      }
    }
    return undefined;
  };

  it("builds the app menu and wires actions", () => {
    buildAppMenu();

    expect(setAboutPanelOptions).toHaveBeenCalledWith(
      expect.objectContaining({ applicationName: "Asteria Studio", applicationVersion: "1.0.0" })
    );
    expect(setApplicationMenu).toHaveBeenCalledOnce();

    const template = buildFromTemplate.mock.calls[0]?.[0] as MenuItem[];

    const preferences = findMenuItem(template, "Preferences…");
    preferences?.click?.();
    expect(send).toHaveBeenCalledWith("asteria:menu-action", "app:preferences");

    const importCorpus = findMenuItem(template, "Import Corpus…");
    importCorpus?.click?.();
    expect(send).toHaveBeenCalledWith("asteria:menu-action", "file:import-corpus");

    const exportRun = findMenuItem(template, "Export Run…");
    exportRun?.click?.();
    expect(send).toHaveBeenCalledWith("asteria:menu-action", "file:export-run");

    const openRunFolder = findMenuItem(template, "Open Current Run Folder");
    openRunFolder?.click?.();
    expect(send).toHaveBeenCalledWith("asteria:menu-action", "file:open-current-run");

    const diagnostics = findMenuItem(template, "Copy Diagnostics Bundle");
    diagnostics?.click?.();
    expect(send).toHaveBeenCalledWith("asteria:menu-action", "help:diagnostics");

    const openLogs = findMenuItem(template, "Open Logs Folder");
    openLogs?.click?.();
    expect(send).toHaveBeenCalledWith("asteria:menu-action", "help:open-logs");

    const shortcuts = findMenuItem(template, "Keyboard Shortcuts");
    shortcuts?.click?.();
    expect(send).toHaveBeenCalledWith("asteria:menu-action", "help:shortcuts");

    const overlays = findMenuItem(template, "Toggle Overlays");
    overlays?.click?.();
    expect(send).toHaveBeenCalledWith("asteria:menu-action", "view:toggle-overlays");

    const guides = findMenuItem(template, "Toggle Guides");
    guides?.click?.();
    expect(send).toHaveBeenCalledWith("asteria:menu-action", "view:toggle-guides");

    const rulers = findMenuItem(template, "Toggle Rulers");
    rulers?.click?.();
    expect(send).toHaveBeenCalledWith("asteria:menu-action", "view:toggle-rulers");

    const snapping = findMenuItem(template, "Toggle Snapping");
    snapping?.click?.();
    expect(send).toHaveBeenCalledWith("asteria:menu-action", "view:toggle-snapping");

    const resetView = findMenuItem(template, "Reset View");
    resetView?.click?.();
    expect(send).toHaveBeenCalledWith("asteria:menu-action", "view:reset-view");
  });

  it("falls back to the first window when no focused window", () => {
    getFocusedWindow.mockReturnValue(null);
    const window = { webContents: { send } };
    getAllWindows.mockReturnValue([window]);

    buildAppMenu();

    const template = buildFromTemplate.mock.calls[0]?.[0] as MenuItem[];
    const preferences = findMenuItem(template, "Preferences…");
    preferences?.click?.();
    expect(send).toHaveBeenCalledWith("asteria:menu-action", "app:preferences");
  });

  it("drops menu actions when no windows are available", () => {
    getFocusedWindow.mockReturnValue(null);
    getAllWindows.mockReturnValue([]);

    buildAppMenu();

    const template = buildFromTemplate.mock.calls[0]?.[0] as MenuItem[];
    const preferences = findMenuItem(template, "Preferences…");
    preferences?.click?.();
    expect(send).not.toHaveBeenCalled();
  });
});
