import fs from "node:fs/promises";
import path from "node:path";
import sharp, { type OutputInfo } from "sharp";
import type { PageLayoutElement } from "../ipc/contracts.js";

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
  maxPayloadMb?: number;
  maxDimensionPx?: number;
};

type PreparedRemotePayload = {
  buffer: Buffer;
  width: number;
  height: number;
  mime: string;
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

  const maxPayloadBytes = Math.max(1, Math.round((config.maxPayloadMb ?? 8) * 1024 * 1024));
  const maxDimensionPx = Math.max(1, Math.round(config.maxDimensionPx ?? 2048));

  const preparePayload = async (): Promise<PreparedRemotePayload | null> => {
    try {
      const stats = await fs.stat(imagePath);
      const withinSize = stats.size <= maxPayloadBytes;
      const withinDimensions = outputWidth <= maxDimensionPx && outputHeight <= maxDimensionPx;
      if (withinSize && withinDimensions) {
        const buffer = await fs.readFile(imagePath);
        return { buffer, width: outputWidth, height: outputHeight, mime: "image/png" };
      }

      const resize = async (quality: number): Promise<{ data: Buffer; info: OutputInfo }> => {
        return sharp(imagePath)
          .resize({
            width: maxDimensionPx,
            height: maxDimensionPx,
            fit: "inside",
            withoutEnlargement: true,
          })
          .jpeg({ quality })
          .toBuffer({ resolveWithObject: true });
      };

      let data = await resize(80);
      if (data.data.length > maxPayloadBytes) {
        data = await resize(60);
      }

      if (data.data.length > maxPayloadBytes) {
        return null;
      }

      return {
        buffer: data.data,
        width: data.info.width ?? outputWidth,
        height: data.info.height ?? outputHeight,
        mime: "image/jpeg",
      };
    } catch {
      return null;
    }
  };

  const timeoutMs = Number(config.timeoutMs ?? 5000);
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const prepared = await preparePayload();
    if (!prepared) return null;
    const scaleX = outputWidth / Math.max(1, prepared.width);
    const scaleY = outputHeight / Math.max(1, prepared.height);
    const payload = {
      pageId,
      width: prepared.width,
      height: prepared.height,
      imageBase64: prepared.buffer.toString("base64"),
      imageMime: prepared.mime,
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
      .map<PageLayoutElement>((element, index) => {
        const scaledBox: [number, number, number, number] = [
          element.bbox[0] * scaleX,
          element.bbox[1] * scaleY,
          element.bbox[2] * scaleX,
          element.bbox[3] * scaleY,
        ];
        return {
          id: element.id ?? `${pageId}-remote-${index}`,
          type: element.type,
          bbox: clampBox(scaledBox, outputWidth, outputHeight),
          confidence: Math.max(0, Math.min(1, element.confidence ?? 0.5)),
          text: element.text,
          notes: element.notes,
          flags: element.flags,
          source: "remote",
        };
      });

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
  const maxPayloadMb = process.env.ASTERIA_REMOTE_LAYOUT_MAX_PAYLOAD_MB;
  const maxDimensionPx = process.env.ASTERIA_REMOTE_LAYOUT_MAX_DIMENSION_PX;
  if (endpoint || token || timeoutMs || maxPayloadMb || maxDimensionPx) {
    return {
      endpoint: endpoint ?? undefined,
      token: token ?? undefined,
      timeoutMs: timeoutMs ? Number(timeoutMs) : undefined,
      maxPayloadMb: maxPayloadMb ? Number(maxPayloadMb) : undefined,
      maxDimensionPx: maxDimensionPx ? Number(maxDimensionPx) : undefined,
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
    const maxPayloadValue = readYamlScalar(raw, "remote_layout_max_payload_mb");
    const maxDimensionValue = readYamlScalar(raw, "remote_layout_max_dimension_px");
    const resolvedToken = tokenEnv ? process.env[tokenEnv] : undefined;
    return {
      endpoint: endpointValue ?? undefined,
      token: resolvedToken ?? undefined,
      timeoutMs: timeoutValue ? Number(timeoutValue) : undefined,
      maxPayloadMb: maxPayloadValue ? Number(maxPayloadValue) : undefined,
      maxDimensionPx: maxDimensionValue ? Number(maxDimensionValue) : undefined,
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
