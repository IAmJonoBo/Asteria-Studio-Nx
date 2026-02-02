import type { JSX } from "react";
import { useState, useEffect, useRef } from "react";
import { useKeyboardShortcut } from "../hooks/useKeyboardShortcut";

interface CommandItem {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  action: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  commands: CommandItem[];
}

export function CommandPalette({
  isOpen,
  onClose,
  commands,
}: Readonly<CommandPaletteProps>): JSX.Element | null {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<globalThis.HTMLInputElement | null>(null);

  const filtered = commands.filter(
    (cmd) =>
      cmd.label.toLowerCase().includes(query.toLowerCase()) ||
      cmd.category.toLowerCase().includes(query.toLowerCase())
  );

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
    }
  }, [isOpen]);

  const activeIndex =
    filtered.length === 0 ? 0 : Math.min(Math.max(selectedIndex, 0), filtered.length - 1);

  useKeyboardShortcut({
    key: "ArrowDown",
    handler: () => {
      if (isOpen && filtered.length > 0) {
        setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
      }
    },
    description: "Move down in command palette",
    disabled: !isOpen,
  });

  useKeyboardShortcut({
    key: "ArrowUp",
    handler: () => {
      if (isOpen) setSelectedIndex((i) => Math.max(i - 1, 0));
    },
    description: "Move up in command palette",
    disabled: !isOpen,
  });

  useKeyboardShortcut({
    key: "Enter",
    handler: () => {
      if (isOpen && filtered[activeIndex]) {
        filtered[activeIndex].action();
        onClose();
      }
    },
    description: "Execute selected command",
    disabled: !isOpen,
  });

  useKeyboardShortcut({
    key: "Escape",
    handler: onClose,
    description: "Close command palette",
    disabled: !isOpen,
  });

  if (!isOpen) return null;

  return (
    <dialog
      style={{
        position: "fixed",
        inset: 0,
        background: "transparent",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "15vh",
        zIndex: 1300,
        border: "none",
        width: "100%",
        height: "100%",
      }}
      open
      aria-modal="true"
      aria-label="Command palette"
    >
      <button
        type="button"
        aria-label="Close command palette"
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          border: "none",
          background: "rgba(0, 0, 0, 0.5)",
          padding: 0,
          margin: 0,
          cursor: "pointer",
        }}
      />
      <div
        style={{
          background: "var(--bg-primary)",
          border: "1px solid var(--border)",
          borderRadius: "12px",
          width: "600px",
          maxWidth: "90vw",
          maxHeight: "70vh",
          display: "flex",
          flexDirection: "column",
          boxShadow: "var(--shadow-xl)",
          position: "relative",
        }}
      >
        <div style={{ padding: "16px", borderBottom: "1px solid var(--border)" }}>
          <input
            ref={inputRef}
            type="text"
            placeholder="Type a command or search..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            className="input"
            style={{ border: "none", background: "var(--bg-surface)" }}
            aria-label="Command search"
          />
        </div>

        <div style={{ flex: 1, overflow: "auto" }}>
          {filtered.length === 0 ? (
            <div className="empty-state" style={{ padding: "48px 24px" }}>
              <p className="empty-state-title">No commands found</p>
              <p className="empty-state-description">
                Try a different search term or browse available commands
              </p>
            </div>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {filtered.map((cmd, index) => (
                <li key={cmd.id}>
                  <button
                    id={cmd.id}
                    type="button"
                    aria-current={index === activeIndex ? "true" : undefined}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => {
                      cmd.action();
                      onClose();
                    }}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "12px 16px",
                      border: "none",
                      background: index === activeIndex ? "var(--bg-surface-hover)" : "transparent",
                      color: "var(--text-primary)",
                      cursor: "pointer",
                      textAlign: "left",
                      transition: "background 150ms, box-shadow 150ms",
                      boxShadow: index === activeIndex ? "0 0 0 2px var(--border)" : "none",
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: index === activeIndex ? 600 : 500 }}>
                        {cmd.label}
                      </div>
                      <div style={{ fontSize: "12px", color: "var(--text-secondary)" }}>
                        {cmd.category}
                      </div>
                    </div>
                    {cmd.shortcut && (
                      <kbd
                        style={{
                          padding: "4px 8px",
                          fontSize: "11px",
                          background: "var(--bg-surface)",
                          border: "1px solid var(--border)",
                          borderRadius: "4px",
                          color: "var(--text-tertiary)",
                        }}
                      >
                        {cmd.shortcut}
                      </kbd>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div
          style={{
            padding: "8px 16px",
            borderTop: "1px solid var(--border)",
            fontSize: "11px",
            color: "var(--text-tertiary)",
            display: "flex",
            gap: "16px",
          }}
        >
          <span>↑↓ Navigate</span>
          <span>⏎ Select</span>
          <span>Esc Close</span>
        </div>
      </div>
    </dialog>
  );
}
