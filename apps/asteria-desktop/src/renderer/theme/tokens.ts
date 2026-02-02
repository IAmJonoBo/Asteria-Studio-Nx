/**
 * Design system tokens for Asteria Studio
 * Following WCAG 2.2 Level AA contrast requirements
 */

export const tokens = {
  // Spacing scale (4px base grid)
  spacing: {
    xs: "4px",
    sm: "8px",
    md: "12px",
    lg: "16px",
    xl: "24px",
    "2xl": "32px",
    "3xl": "48px",
    "4xl": "64px",
  },

  // Typography scale
  typography: {
    fontFamily: {
      sans: '"Inter", system-ui, -apple-system, sans-serif',
      mono: '"Fira Code", "SF Mono", Consolas, monospace',
    },
    fontSize: {
      xs: "11px",
      sm: "12px",
      base: "14px",
      lg: "16px",
      xl: "18px",
      "2xl": "24px",
      "3xl": "32px",
    },
    fontWeight: {
      normal: 400,
      medium: 500,
      semibold: 600,
      bold: 700,
    },
    lineHeight: {
      tight: 1.25,
      normal: 1.5,
      relaxed: 1.75,
    },
  },

  // Border radius
  radius: {
    none: "0",
    sm: "4px",
    md: "6px",
    lg: "8px",
    xl: "12px",
    full: "9999px",
  },

  // Shadows
  shadow: {
    sm: "0 1px 2px rgba(0, 0, 0, 0.05)",
    md: "0 4px 6px rgba(0, 0, 0, 0.07)",
    lg: "0 10px 15px rgba(0, 0, 0, 0.1)",
    xl: "0 20px 25px rgba(0, 0, 0, 0.1)",
    focus: "0 0 0 3px rgba(59, 130, 246, 0.5)",
  },

  // Semantic colors - light mode
  colors: {
    light: {
      // Surfaces
      background: "#ffffff",
      surface: "#f9fafb",
      surfaceHover: "#f3f4f6",
      surfaceActive: "#e5e7eb",
      border: "#d1d5db",
      borderSubtle: "#e5e7eb",

      // Text
      text: "#111827",
      textSecondary: "#6b7280",
      textTertiary: "#9ca3af",
      textInverse: "#ffffff",

      // Interactive
      primary: "#3b82f6",
      primaryHover: "#2563eb",
      primaryActive: "#1d4ed8",
      primaryText: "#ffffff",

      // Status
      success: "#10b981",
      successBg: "#d1fae5",
      successText: "#065f46",
      warning: "#f59e0b",
      warningBg: "#fef3c7",
      warningText: "#92400e",
      error: "#ef4444",
      errorBg: "#fee2e2",
      errorText: "#991b1b",
      info: "#3b82f6",
      infoBg: "#dbeafe",
      infoText: "#1e40af",

      // Focus
      focus: "#3b82f6",
      focusRing: "rgba(59, 130, 246, 0.5)",

      // Overlay colors for review
      overlayPageBounds: "#3b82f6",
      overlayContentBox: "#10b981",
      overlayTextBlock: "#f59e0b",
      overlayOrnament: "#8b5cf6",
      overlayRunningHead: "#ec4899",
      overlayFolio: "#06b6d4",
      overlayGutter: "#ef4444",
    },

    // Dark mode
    dark: {
      background: "#0f172a",
      surface: "#1e293b",
      surfaceHover: "#334155",
      surfaceActive: "#475569",
      border: "#475569",
      borderSubtle: "#334155",

      text: "#f8fafc",
      textSecondary: "#cbd5e1",
      textTertiary: "#94a3b8",
      textInverse: "#0f172a",

      primary: "#3b82f6",
      primaryHover: "#60a5fa",
      primaryActive: "#93c5fd",
      primaryText: "#ffffff",

      success: "#10b981",
      successBg: "#064e3b",
      successText: "#6ee7b7",
      warning: "#f59e0b",
      warningBg: "#78350f",
      warningText: "#fcd34d",
      error: "#ef4444",
      errorBg: "#7f1d1d",
      errorText: "#fca5a5",
      info: "#3b82f6",
      infoBg: "#1e3a8a",
      infoText: "#93c5fd",

      focus: "#60a5fa",
      focusRing: "rgba(96, 165, 250, 0.5)",

      overlayPageBounds: "#60a5fa",
      overlayContentBox: "#34d399",
      overlayTextBlock: "#fbbf24",
      overlayOrnament: "#a78bfa",
      overlayRunningHead: "#f472b6",
      overlayFolio: "#22d3ee",
      overlayGutter: "#f87171",
    },
  },

  // Transitions
  transition: {
    fast: "150ms cubic-bezier(0.4, 0, 0.2, 1)",
    base: "200ms cubic-bezier(0.4, 0, 0.2, 1)",
    slow: "300ms cubic-bezier(0.4, 0, 0.2, 1)",
  },

  // Z-index layers
  zIndex: {
    base: 0,
    dropdown: 1000,
    sticky: 1100,
    overlay: 1200,
    modal: 1300,
    popover: 1400,
    tooltip: 1500,
  },
} as const;

export type Theme = "light" | "dark";
