import { app, BrowserWindow, Menu } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { getAppInfo } from "./app-info.js";

const getActiveWindow = (): BrowserWindow | null => {
  const focused = BrowserWindow.getFocusedWindow();
  if (focused) return focused;
  return BrowserWindow.getAllWindows()[0] ?? null;
};

const sendMenuAction = (actionId: string): void => {
  const window = getActiveWindow();
  if (!window) return;
  window.webContents.send("asteria:menu-action", actionId);
};

export const buildAppMenu = (): void => {
  const appInfo = getAppInfo();
  const buildLabel = appInfo.buildHash ?? appInfo.commit ?? "dev";

  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: appInfo.version,
    version: buildLabel,
    copyright: `© ${new Date().getFullYear()} ${app.getName()}`,
  });

  const appMenu: MenuItemConstructorOptions = {
    label: app.getName(),
    submenu: [
      { role: "about", label: `About ${app.getName()}` },
      { type: "separator" },
      {
        label: "Preferences…",
        accelerator: "CmdOrCtrl+,",
        click: () => sendMenuAction("app:preferences"),
      },
      { type: "separator" },
      { role: "hide", label: `Hide ${app.getName()}` },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      { role: "quit" },
    ],
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: "File",
    submenu: [
      {
        label: "Import Corpus…",
        accelerator: "CmdOrCtrl+O",
        click: () => sendMenuAction("file:import-corpus"),
      },
      {
        label: "Export Run…",
        accelerator: "CmdOrCtrl+E",
        click: () => sendMenuAction("file:export-run"),
      },
      {
        label: "Open Current Run Folder",
        accelerator: "CmdOrCtrl+Shift+O",
        click: () => sendMenuAction("file:open-current-run"),
      },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      {
        label: "Toggle Overlays",
        accelerator: "CmdOrCtrl+Shift+L",
        click: () => sendMenuAction("view:toggle-overlays"),
      },
      {
        label: "Toggle Guides",
        accelerator: "G",
        click: () => sendMenuAction("view:toggle-guides"),
      },
      {
        label: "Toggle Rulers",
        accelerator: "Shift+G",
        click: () => sendMenuAction("view:toggle-rulers"),
      },
      {
        label: "Toggle Snapping",
        accelerator: "S",
        click: () => sendMenuAction("view:toggle-snapping"),
      },
      {
        label: "Reset View",
        accelerator: "0",
        click: () => sendMenuAction("view:reset-view"),
      },
      { type: "separator" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ],
  };

  const helpMenu: MenuItemConstructorOptions = {
    label: "Help",
    submenu: [
      {
        label: "Open Logs Folder",
        click: () => sendMenuAction("help:open-logs"),
      },
      {
        label: "Copy Diagnostics Bundle",
        click: () => sendMenuAction("help:diagnostics"),
      },
      {
        label: "Keyboard Shortcuts",
        click: () => sendMenuAction("help:shortcuts"),
      },
    ],
  };

  const template: MenuItemConstructorOptions[] = [appMenu, fileMenu, viewMenu, helpMenu];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
};
