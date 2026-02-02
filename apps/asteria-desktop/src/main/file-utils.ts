import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const writeJsonAtomic = async (filePath: string, payload: unknown): Promise<void> => {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${crypto.randomUUID()}.tmp`);
  const data = JSON.stringify(payload, null, 2);
  await fs.writeFile(tempPath, data);
  await fs.rename(tempPath, filePath);
};
