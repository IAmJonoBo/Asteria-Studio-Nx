import path from "node:path";
import { notarize } from "@electron/notarize";

const hasNotarytoolApi = () =>
  Boolean(
    process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER
  );

const hasAppleIdAuth = () =>
  Boolean(
    process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID
  );

export default async function notarizeApp(context) {
  if (process.platform !== "darwin") return;

  const { appOutDir, packager } = context;
  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  if (hasNotarytoolApi()) {
    await notarize({
      appPath,
      tool: "notarytool",
      appleApiKey: process.env.APPLE_API_KEY,
      appleApiKeyId: process.env.APPLE_API_KEY_ID,
      appleApiIssuer: process.env.APPLE_API_ISSUER,
    });
    return;
  }

  if (hasAppleIdAuth()) {
    await notarize({
      appPath,
      tool: "notarytool",
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    });
    return;
  }

  console.warn(
    "Notarization skipped: missing APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID or APPLE_API_KEY/APPLE_API_KEY_ID/APPLE_API_ISSUER."
  );
}
