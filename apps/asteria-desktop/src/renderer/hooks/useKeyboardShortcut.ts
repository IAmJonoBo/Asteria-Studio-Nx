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

    const handler = (e: KeyboardEvent): void => {
      const current = shortcutRef.current;
      if (current.disabled) return;

      const isMac = navigator.platform.toUpperCase().includes("MAC");
      const modKey = isMac ? e.metaKey : e.ctrlKey;

      const keyMatch = e.key.toLowerCase() === current.key.toLowerCase();
      const ctrlMatch = current.ctrlKey !== undefined ? modKey === current.ctrlKey : true;
      const shiftMatch = current.shiftKey !== undefined ? e.shiftKey === current.shiftKey : true;
      const altMatch = current.altKey !== undefined ? e.altKey === current.altKey : true;

      if (keyMatch && ctrlMatch && shiftMatch && altMatch) {
        e.preventDefault();
        current.handler();
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shortcut.disabled]);
}

export function useKeyboardShortcuts(shortcuts: KeyboardShortcut[]): void {
  shortcuts.forEach((shortcut) => {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useKeyboardShortcut(shortcut);
  });
}
