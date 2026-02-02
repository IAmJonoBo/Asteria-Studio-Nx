import fs from "node:fs/promises";
import path from "node:path";
import type { PageLayoutElement } from "../ipc/contracts";

const ALLOWED_TYPES = new Set<PageLayoutElement["type"]>([
  "page_bounds",
  "text_block",
  "title",
  "running_head",
  "folio",
  "ornament",
  "drop_cap",
  "footnote",
  "marginalia",
]);

const isAllowedType = (type: string | undefined): type is PageLayoutElement["type"] => {
  return Boolean(type && ALLOWED_TYPES.has(type as PageLayoutElement["type"]));
};

type RemoteElement = {
  id?: string;
  type?: string;
  bbox?: [number, number, number, number];
  confidence?: number;
  text?: string;
  notes?: string;
  flags?: string[];
};

type RemoteLayoutResponse = {
  elements?: RemoteElement[];
};

type RemoteLayoutConfig = {
  endpoint?: string;
  token?: string;
  timeoutMs?: number;
};

const clampBox = (
  box: [number, number, number, number],
  width: number,
  height: number
): [number, number, number, number] => {
  const x0 = Math.max(0, Math.min(width - 1, Math.round(box[0])));
  const y0 = Math.max(0, Math.min(height - 1, Math.round(box[1])));
  const x1 = Math.max(x0 + 1, Math.min(width - 1, Math.round(box[2])));
  const y1 = Math.max(y0 + 1, Math.min(height - 1, Math.round(box[3])));
  return [x0, y0, x1, y1];
};

export const requestRemoteLayout = async (
  pageId: string,
  imagePath: string,
  outputWidth: number,
  outputHeight: number
): Promise<PageLayoutElement[] | null> => {
  const config = await loadRemoteLayoutConfig();
  const endpoint = config.endpoint;
  if (!endpoint) return null;

  const timeoutMs = Number(config.timeoutMs ?? 5000);
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const file = await fs.readFile(imagePath);
    const payload = {
      pageId,
      width: outputWidth,
      height: outputHeight,
      imageBase64: file.toString("base64"),
    };
    const token = config.token;
    const response = await globalThis.fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data: RemoteLayoutResponse = await response.json();
    const elements = (data.elements ?? [])
      .filter(
        (
          element
        ): element is Required<Pick<RemoteElement, "type" | "bbox">> &
          RemoteElement & { type: PageLayoutElement["type"] } => {
          return Boolean(element.type && element.bbox && isAllowedType(element.type));
        }
      )
      .map<PageLayoutElement>((element, index) => ({
        id: element.id ?? `${pageId}-remote-${index}`,
        type: element.type,
        bbox: clampBox(element.bbox, outputWidth, outputHeight),
        confidence: Math.max(0, Math.min(1, element.confidence ?? 0.5)),
        text: element.text,
        notes: element.notes,
        flags: element.flags,
        source: "remote",
      }));

    return elements.length > 0 ? elements : null;
  } catch {
    return null;
  } finally {
    globalThis.clearTimeout(timeout);
  }
};

const loadRemoteLayoutConfig = async (): Promise<RemoteLayoutConfig> => {
  const endpoint = process.env.ASTERIA_REMOTE_LAYOUT_ENDPOINT;
  const token = process.env.ASTERIA_REMOTE_LAYOUT_TOKEN;
  const timeoutMs = process.env.ASTERIA_REMOTE_LAYOUT_TIMEOUT_MS;
  if (endpoint || token || timeoutMs) {
    return {
      endpoint: endpoint ?? undefined,
      token: token ?? undefined,
      timeoutMs: timeoutMs ? Number(timeoutMs) : undefined,
    };
  }

  const candidates = [
    path.join(process.cwd(), "spec", "pipeline_config.yaml"),
    path.resolve(process.cwd(), "..", "..", "spec", "pipeline_config.yaml"),
    path.resolve(process.cwd(), "..", "..", "..", "spec", "pipeline_config.yaml"),
  ];
  const configPath = await findExistingPath(candidates);
  if (!configPath) return {};

  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const endpointValue = readYamlScalar(raw, "remote_layout_endpoint");
    const tokenEnv = readYamlScalar(raw, "remote_layout_token_env");
    const timeoutValue = readYamlScalar(raw, "remote_layout_timeout_ms");
    const resolvedToken = tokenEnv ? process.env[tokenEnv] : undefined;
    return {
      endpoint: endpointValue ?? undefined,
      token: resolvedToken ?? undefined,
      timeoutMs: timeoutValue ? Number(timeoutValue) : undefined,
    };
  } catch {
    return {};
  }
};

const findExistingPath = async (paths: string[]): Promise<string | null> => {
  for (const candidate of paths) {
    try {
      const stats = await fs.stat(candidate);
      if (stats.isFile()) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
};

const readYamlScalar = (raw: string, key: string): string | null => {
  const pattern = new RegExp(String.raw`^\s*${key}:\s*(.+)$`, "m");
  const match = pattern.exec(raw);
  if (!match) return null;
  const value = match[1].split("#")[0].trim();
  if (value === "null" || value === "") return null;
  return value.replace(/^["']/, "").replace(/["']$/, "");
};
