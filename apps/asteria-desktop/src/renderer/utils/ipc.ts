import type { IpcErrorPayload, IpcResult } from "../../ipc/contracts.js";

export const unwrapIpcResult = <T>(result: IpcResult<T>, context?: string): T => {
  if (result.ok) return result.value;
  const prefix = context ? `${context}: ` : "";
  throw new Error(`${prefix}${result.error.message}`);
};

export const unwrapIpcResultOr = <T>(result: IpcResult<T>, fallback: T): T =>
  result.ok ? result.value : fallback;

export const ipcErrorToMessage = (error: IpcErrorPayload, context?: string): string => {
  const prefix = context ? `${context}: ` : "";
  return `${prefix}${error.message}`;
};
