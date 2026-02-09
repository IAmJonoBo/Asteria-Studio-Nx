import { app, BrowserWindow, dialog, protocol } from "electron";
import { fileURLToPath } from "url";
import path from "path";
import { loadEnv } from "./config.js";
import { buildAppMenu } from "./menu.js";
import { getAsteriaRoot, loadPreferences, savePreferences } from "./preferences.js";

loadEnv();

protocol.registerSchemesAsPrivileged([
  { scheme: "asteria", privileges: { secure: true, standard: true } },
]);

const isDev = !app.isPackaged || process.env.NODE_ENV === "development";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const attachLoadLogging = (win: BrowserWindow): void => {
  const { webContents } = win;

  webContents.on("did-start-loading", () => {
    console.warn("[renderer] loading start");
    win.setTitle("Asteria Studio — Loading…");
  });

  webContents.on("did-stop-loading", () => {
    console.warn("[renderer] loading complete");
    win.setTitle("Asteria Studio");
  });

  webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    console.error(`[renderer] failed to load ${url}: ${description} (${code})`);
    if (isMainFrame) {
      dialog.showErrorBox(
        "Asteria Studio - UI Load Failed",
        `Failed to load the renderer UI.\\n\\n${description} (${code})\\n${url}`
      );
    }
  });

  webContents.on("render-process-gone", (_event, details) => {
    console.error(`[renderer] process gone: ${details.reason} (${details.exitCode})`);
  });

  webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.warn(`[renderer][${level}] ${message} (${sourceId}:${line})`);
  });
};

const ensureSharp = async (): Promise<boolean> => {
  try {
    await import("sharp");
    return true;
  } catch (error) {
    const message = [
      "Sharp failed to load. Native image processing will be unavailable.",
      "",
      "Possible fixes:",
      "- Ensure optional dependencies are installed (pnpm install --include=optional).",
      "- For packaged builds, ensure native modules are unpacked from ASAR.",
      "- If packaging, run `pnpm -C apps/asteria-desktop exec electron-builder install-app-deps`.",
      "- Rebuild sharp for the current Electron runtime if needed.",
    ].join("\n");
    console.error(message);
    console.error(error instanceof Error ? error.message : String(error));
    if (app.isReady()) {
      dialog.showErrorBox("Asteria Studio - Sharp Load Error", message);
    }
    return false;
  }
};

const registerAssetProtocol = (allowedRoots: string[]): void => {
  const roots = allowedRoots
    .filter((root): root is string => typeof root === "string" && root.trim().length > 0)
    .map((root) => path.resolve(root));
  const rootEntries = roots.map((root) => ({
    root,
    rootWithSep: root.endsWith(path.sep) ? root : `${root}${path.sep}`,
  }));
  const isAllowedPath = (targetPath: string): boolean =>
    rootEntries.some(
      ({ root, rootWithSep }) => targetPath === root || targetPath.startsWith(rootWithSep)
    );

  protocol.registerFileProtocol("asteria", (request, callback) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "asset") {
        callback({ error: -6 });
        return;
      }
      const rawPath = url.searchParams.get("path");
      if (!rawPath) {
        callback({ error: -6 });
        return;
      }
      const decodedPath = decodeURIComponent(rawPath);
      const normalizedPath = path.isAbsolute(decodedPath)
        ? path.normalize(decodedPath)
        : path.resolve(decodedPath);
      if (!isAllowedPath(normalizedPath)) {
        callback({ error: -10 });
        return;
      }
      callback({ path: normalizedPath });
    } catch {
      callback({ error: -6 });
    }
  });
};

async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  attachLoadLogging(win);

  if (isDev) {
    await win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    const indexPath = path.join(__dirname, "../renderer/index.html");
    await win.loadFile(indexPath);
  }
}

app
  .whenReady()
  .then(async () => {
    const sharpOk = await ensureSharp();
    if (!sharpOk) {
      app.exit(1);
      return;
    }

    const prefs = await loadPreferences();
    if (prefs.lastVersion !== app.getVersion()) {
      await savePreferences({ lastVersion: app.getVersion() });
    }

    buildAppMenu();
    registerAssetProtocol([getAsteriaRoot(app.getPath("userData")), prefs.outputDir]);

    const { registerIpcHandlers } = await import("./ipc.js");
    registerIpcHandlers();
    await createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  })
  .catch((err) => {
    console.error("Failed to start app:", err);
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
