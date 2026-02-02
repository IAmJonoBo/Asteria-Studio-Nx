import type { JSX } from "react";

export type NavItem = "projects" | "runs" | "monitor" | "review" | "exports" | "settings";

interface NavigationProps {
  active: NavItem;
  onNavigate: (item: NavItem) => void;
}

const navItems: Array<{
  id: NavItem;
  label: string;
  icon: string;
  shortcut?: string;
}> = [
  { id: "projects", label: "Projects", icon: "📁", shortcut: "1" },
  { id: "runs", label: "Run History", icon: "📊", shortcut: "2" },
  { id: "monitor", label: "Live Monitor", icon: "⚡", shortcut: "3" },
  { id: "review", label: "Review Queue", icon: "🔍", shortcut: "4" },
  { id: "exports", label: "Exports", icon: "📦", shortcut: "5" },
  { id: "settings", label: "Settings", icon: "⚙️", shortcut: "6" },
];

export function Navigation({ active, onNavigate }: Readonly<NavigationProps>): JSX.Element {
  return (
    <nav className="app-nav" role="navigation" aria-label="Main navigation">
      <div
        style={{
          padding: "16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <h1
          style={{
            margin: 0,
            fontSize: "18px",
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          Asteria Studio
        </h1>
        <p
          style={{
            margin: "4px 0 0",
            fontSize: "11px",
            color: "var(--text-tertiary)",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          Page Normalization
        </p>
      </div>

      <div style={{ flex: 1, padding: "8px" }}>
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            aria-current={active === item.id ? "page" : undefined}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: "12px",
              padding: "10px 12px",
              marginBottom: "2px",
              border: "none",
              borderRadius: "6px",
              background: active === item.id ? "var(--bg-surface-hover)" : "transparent",
              color: active === item.id ? "var(--text-primary)" : "var(--text-secondary)",
              fontSize: "14px",
              fontWeight: active === item.id ? 600 : 400,
              cursor: "pointer",
              transition: "all 150ms",
              textAlign: "left",
            }}
            onMouseEnter={(e) => {
              if (active !== item.id) {
                e.currentTarget.style.background = "var(--bg-surface-hover)";
              }
            }}
            onMouseLeave={(e) => {
              if (active !== item.id) {
                e.currentTarget.style.background = "transparent";
              }
            }}
          >
            <span style={{ fontSize: "18px" }} aria-hidden="true">
              {item.icon}
            </span>
            <span style={{ flex: 1 }}>{item.label}</span>
            {item.shortcut && (
              <kbd
                style={{
                  padding: "2px 6px",
                  fontSize: "11px",
                  background: "var(--bg-surface-active)",
                  border: "1px solid var(--border)",
                  borderRadius: "4px",
                  color: "var(--text-tertiary)",
                }}
                aria-label={`Shortcut: ${item.shortcut}`}
              >
                {item.shortcut}
              </kbd>
            )}
          </button>
        ))}
      </div>

      <div
        style={{
          padding: "12px",
          borderTop: "1px solid var(--border)",
        }}
      >
        <button
          className="btn btn-ghost"
          style={{ width: "100%", fontSize: "12px" }}
          aria-label="Open command palette (Ctrl+K or Cmd+K)"
        >
          <span>⌘</span>
          <span>Command Palette</span>
        </button>
      </div>
    </nav>
  );
}
