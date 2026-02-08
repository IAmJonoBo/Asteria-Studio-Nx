import { spawn } from "node:child_process";

const env = { ...process.env };
if (process.platform === "linux" && !env.ELECTRON_DISABLE_SANDBOX) {
  env.ELECTRON_DISABLE_SANDBOX = "1";
}
if (
  process.platform === "linux" &&
  !env.DISPLAY &&
  !env.WAYLAND_DISPLAY &&
  env.ASTERIA_SKIP_ELECTRON !== "0"
) {
  console.warn("[dev:main] No display detected; skipping Electron launch.");
  console.warn("[dev:main] Set DISPLAY/WAYLAND_DISPLAY or ASTERIA_SKIP_ELECTRON=0 to override.");
  process.exit(0);
}

const electronCommand = process.platform === "win32" ? "electron.cmd" : "electron";
const child = spawn(electronCommand, ["."], {
  stdio: "inherit",
  env,
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
