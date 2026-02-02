import { useEffect, useRef } from "react";

export interface KeyboardShortcut {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  handler: () => void;
  description: string;
  disabled?: boolean;
}

type KeyEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  preventDefault: () => void;
};

/**
 * Register keyboard shortcuts with proper cleanup
 * Supports Ctrl/Cmd modifier normalization for cross-platform
 */
export function useKeyboardShortcut(shortcut: KeyboardShortcut): void {
  const shortcutRef = useRef(shortcut);
  useEffect(() => {
    shortcutRef.current = shortcut;
  }, [shortcut]);

  useEffect(() => {
    if (shortcut.disabled) return;

    const handler = (e: KeyEvent): void => {
      const current = shortcutRef.current;
      if (current.disabled) return;

      const userAgent = globalThis.navigator?.userAgent ?? "";
      const isMac = userAgent.toUpperCase().includes("MAC");
      const modKey = isMac ? e.metaKey : e.ctrlKey;

      const keyMatch = e.key.toLowerCase() === current.key.toLowerCase();
      const ctrlMatch = current.ctrlKey === undefined || modKey === current.ctrlKey;
      const shiftMatch = current.shiftKey === undefined || e.shiftKey === current.shiftKey;
      const altMatch = current.altKey === undefined || e.altKey === current.altKey;

      if (keyMatch && ctrlMatch && shiftMatch && altMatch) {
        e.preventDefault();
        current.handler();
      }
    };

    type EventTargetLike = {
      addEventListener?: (type: string, listener: (event: KeyEvent) => void) => void;
      removeEventListener?: (type: string, listener: (event: KeyEvent) => void) => void;
    };
    const target = globalThis as EventTargetLike;
    if (!target.addEventListener) return;
    target.addEventListener("keydown", handler);
    return (): void => {
      target.removeEventListener?.("keydown", handler);
    };
  }, [shortcut.disabled]);
}

export function useKeyboardShortcuts(shortcuts: KeyboardShortcut[]): void {
  const shortcutsRef = useRef(shortcuts);
  useEffect(() => {
    shortcutsRef.current = shortcuts;
  }, [shortcuts]);

  useEffect(() => {
    const handler = (e: KeyEvent): void => {
      const activeShortcuts = shortcutsRef.current;
      if (!Array.isArray(activeShortcuts)) return;

      const userAgent = globalThis.navigator?.userAgent ?? "";
      const isMac = userAgent.toUpperCase().includes("MAC");
      const modKey = isMac ? e.metaKey : e.ctrlKey;

      for (const current of activeShortcuts) {
        if (current.disabled) continue;

        const keyMatch = e.key.toLowerCase() === current.key.toLowerCase();
        const ctrlMatch = current.ctrlKey === undefined || modKey === current.ctrlKey;
        const shiftMatch = current.shiftKey === undefined || e.shiftKey === current.shiftKey;
        const altMatch = current.altKey === undefined || e.altKey === current.altKey;

        if (keyMatch && ctrlMatch && shiftMatch && altMatch) {
          e.preventDefault();
          current.handler();
          break;
        }
      }
    };

    type EventTargetLike = {
      addEventListener?: (type: string, listener: (event: KeyEvent) => void) => void;
      removeEventListener?: (type: string, listener: (event: KeyEvent) => void) => void;
    };
    const target = globalThis as EventTargetLike;
    if (!target.addEventListener) return;
    target.addEventListener("keydown", handler);
    return (): void => {
      target.removeEventListener?.("keydown", handler);
    };
  }, []);
}
