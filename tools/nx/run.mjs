import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const env = { ...process.env };

const cacheMode = (env.NX_CACHE_MODE || "local").toLowerCase();
const remoteUrl = env.NX_REMOTE_CACHE_URL;
const remoteToken = env.NX_REMOTE_CACHE_ACCESS_TOKEN;

if (cacheMode === "local") {
  env.NX_DISABLE_REMOTE_CACHE = "true";
} else if (cacheMode === "remote") {
  if (remoteUrl && !env.NX_SELF_HOSTED_REMOTE_CACHE_SERVER) {
    env.NX_SELF_HOSTED_REMOTE_CACHE_SERVER = remoteUrl;
  }
  if (remoteToken && !env.NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN) {
    env.NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN = remoteToken;
  }

  const hasNxCloud = Boolean(env.NX_CLOUD_ACCESS_TOKEN || env.NX_CLOUD_AUTH_TOKEN);
  const hasSelfHosted = Boolean(
    env.NX_SELF_HOSTED_REMOTE_CACHE_SERVER || env.NX_SELF_HOSTED_REMOTE_CACHE_ACCESS_TOKEN
  );

  if (!hasNxCloud && !hasSelfHosted) {
    console.warn(
      "[nx] NX_CACHE_MODE=remote set but no remote cache credentials found. Falling back to local cache."
    );
    env.NX_DISABLE_REMOTE_CACHE = "true";
  }
}

const result = spawnSync("pnpm", ["exec", "nx", ...args], {
  stdio: "inherit",
  env,
});

process.exit(result.status ?? 1);
