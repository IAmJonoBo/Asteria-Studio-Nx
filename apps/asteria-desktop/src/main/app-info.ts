import { app } from "electron";
import type { AppInfo } from "../ipc/contracts.js";

const resolveBuildHash = (): string | undefined =>
  process.env.ASTERIA_BUILD_HASH ??
  process.env.VITE_BUILD_HASH ??
  process.env.BUILD_HASH ??
  undefined;

const resolveCommit = (): string | undefined =>
  process.env.ASTERIA_COMMIT ??
  process.env.VITE_COMMIT ??
  process.env.GITHUB_SHA ??
  process.env.COMMIT_SHA ??
  undefined;

export const getAppInfo = (): AppInfo => ({
  version: app.getVersion(),
  buildHash: resolveBuildHash(),
  commit: resolveCommit(),
  platform: process.platform,
});
