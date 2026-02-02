import { useState } from "react";
import type { JSX } from "react";
import { Navigation, type NavItem } from "./components/Navigation";
import { CommandPalette } from "./components/CommandPalette";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { ReviewQueueScreen } from "./screens/ReviewQueueScreen";
import { RunsScreen, MonitorScreen, ExportsScreen, SettingsScreen } from "./screens";
import { useTheme } from "./hooks/useTheme";
import { useKeyboardShortcut } from "./hooks/useKeyboardShortcut";

export function App(): JSX.Element {
  const [theme, setTheme] = useTheme();
  const [activeScreen, setActiveScreen] = useState<NavItem>("projects");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  useKeyboardShortcut({
    key: "k",
    ctrlKey: true,
    handler: () => setCommandPaletteOpen(true),
    description: "Open command palette",
  });

  // Navigation shortcuts (1-6)
  ["1", "2", "3", "4", "5", "6"].forEach((key, index) => {
    const screens: NavItem[] = ["projects", "runs", "monitor", "review", "exports", "settings"];
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useKeyboardShortcut({
      key,
      ctrlKey: true,
      handler: () => setActiveScreen(screens[index]),
      description: `Navigate to ${screens[index]}`,
    });
  });

  const handleImportCorpus = (): void => {
    // Placeholder: wire IPC for corpus import.
  };
  const handleStartRun = (): void => {
    // Placeholder: wire IPC for pipeline run.
  };
  const handleOpenProject = (_id: string): void => {
    // Placeholder: wire IPC to open project.
  };

  const commands = [
    {
      id: "nav-projects",
      label: "Go to Projects",
      category: "Navigation",
      shortcut: "Ctrl+1",
      action: () => setActiveScreen("projects"),
    },
    {
      id: "nav-runs",
      label: "Go to Run History",
      category: "Navigation",
      shortcut: "Ctrl+2",
      action: () => setActiveScreen("runs"),
    },
    {
      id: "nav-monitor",
      label: "Go to Live Monitor",
      category: "Navigation",
      shortcut: "Ctrl+3",
      action: () => setActiveScreen("monitor"),
    },
    {
      id: "nav-review",
      label: "Go to Review Queue",
      category: "Navigation",
      shortcut: "Ctrl+4",
      action: () => setActiveScreen("review"),
    },
    {
      id: "nav-exports",
      label: "Go to Exports",
      category: "Navigation",
      shortcut: "Ctrl+5",
      action: () => setActiveScreen("exports"),
    },
    {
      id: "nav-settings",
      label: "Go to Settings",
      category: "Navigation",
      shortcut: "Ctrl+6",
      action: () => setActiveScreen("settings"),
    },
    {
      id: "toggle-theme",
      label: "Toggle Theme",
      category: "Preferences",
      action: () => setTheme(theme === "light" ? "dark" : "light"),
    },
    {
      id: "import-corpus",
      label: "Import Corpus",
      category: "Actions",
      action: handleImportCorpus,
    },
    {
      id: "start-run",
      label: "Start New Run",
      category: "Actions",
      action: handleStartRun,
    },
  ];

  return (
    <div className="app-layout">
      <Navigation active={activeScreen} onNavigate={setActiveScreen} />

      <div className="app-main">
        <header className="app-header">
          <h2
            style={{ margin: 0, fontSize: "14px", fontWeight: 500, color: "var(--text-secondary)" }}
          >
            {activeScreen.charAt(0).toUpperCase() + activeScreen.slice(1)}
          </h2>
          <div style={{ flex: 1 }} />
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setTheme(theme === "light" ? "dark" : "light")}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
          >
            {theme === "light" ? "🌙" : "☀️"}
          </button>
        </header>

        <main className="app-content">
          {activeScreen === "projects" && (
            <ProjectsScreen onImportCorpus={handleImportCorpus} onOpenProject={handleOpenProject} />
          )}
          {activeScreen === "runs" && <RunsScreen />}
          {activeScreen === "monitor" && <MonitorScreen />}
          {activeScreen === "review" && <ReviewQueueScreen />}
          {activeScreen === "exports" && <ExportsScreen />}
          {activeScreen === "settings" && <SettingsScreen />}
        </main>
      </div>

      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        commands={commands}
      />
    </div>
  );
}
