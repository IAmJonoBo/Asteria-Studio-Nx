import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Navigation, type NavItem } from "./components/Navigation";
import { CommandPalette } from "./components/CommandPalette";
import { ProjectsScreen } from "./screens/ProjectsScreen";
import { ReviewQueueScreen } from "./screens/ReviewQueueScreen";
import { RunsScreen, MonitorScreen, ExportsScreen, SettingsScreen } from "./screens";
import { useTheme } from "./hooks/useTheme";
import { useKeyboardShortcut, useKeyboardShortcuts } from "./hooks/useKeyboardShortcut";
import type { ProjectSummary, PipelineRunConfig } from "../ipc/contracts";

export function App(): JSX.Element {
  const [theme, setTheme] = useTheme();
  const [activeScreen, setActiveScreen] = useState<NavItem>("projects");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined);
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(undefined);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);

  useKeyboardShortcut({
    key: "k",
    ctrlKey: true,
    handler: (): void => setCommandPaletteOpen(true),
    description: "Open command palette",
  });

  useKeyboardShortcuts(
    ["1", "2", "3", "4", "5", "6"].map((key, index) => {
      const screens: NavItem[] = ["projects", "runs", "monitor", "review", "exports", "settings"];
      return {
        key,
        ctrlKey: true,
        handler: (): void => setActiveScreen(screens[index]),
        description: `Navigate to ${screens[index]}`,
      };
    })
  );

  const loadProjects = async (): Promise<void> => {
    const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
      globalThis;
    if (!windowRef.asteria?.ipc) {
      setProjects([]);
      setProjectsLoading(false);
      return;
    }
    try {
      setProjectsLoading(true);
      const listProjects = windowRef.asteria.ipc["asteria:list-projects"] as
        | (() => Promise<ProjectSummary[]>)
        | undefined;
      const data = listProjects ? await listProjects() : [];
      setProjects(data);
      setProjectsError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load projects";
      setProjectsError(message);
    } finally {
      setProjectsLoading(false);
    }
  };

  useEffect(() => {
    void loadProjects();
  }, []);

  useEffect(() => {
    const windowRef: typeof globalThis & {
      asteria?: {
        onRunProgress?: (handler: (event: { runId: string; stage: string }) => void) => () => void;
      };
    } = globalThis;
    if (!windowRef.asteria?.onRunProgress) return;
    const unsubscribe = windowRef.asteria.onRunProgress((event) => {
      if (event.stage === "complete") {
        setSelectedRunId(event.runId);
        setActiveScreen("runs");
      }
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  const handleImportCorpus = async (): Promise<void> => {
    const inputPath = globalThis.prompt("Enter the folder path for the corpus");
    if (!inputPath) return;
    const name = globalThis.prompt("Project name (optional)") ?? undefined;
    const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
      globalThis;
    if (!windowRef.asteria?.ipc) return;
    const importCorpus = windowRef.asteria.ipc["asteria:import-corpus"] as
      | ((request: { inputPath: string; name?: string }) => Promise<ProjectSummary>)
      | undefined;
    if (!importCorpus) return;
    try {
      await importCorpus({ inputPath, name });
      await loadProjects();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to import corpus";
      globalThis.alert(message);
    }
  };

  const handleStartRun = async (project?: ProjectSummary): Promise<void> => {
    const selectedProject =
      project ?? projects.find((item) => item.id === activeProjectId) ?? projects[0];
    if (!selectedProject) {
      globalThis.alert("Select a project to start a run.");
      return;
    }
    const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
      globalThis;
    if (!windowRef.asteria?.ipc) return;
    const scanCorpus = windowRef.asteria.ipc["asteria:scan-corpus"] as
      | ((rootPath: string, options?: { projectId?: string }) => Promise<PipelineRunConfig>)
      | undefined;
    const startRun = windowRef.asteria.ipc["asteria:start-run"] as
      | ((config: PipelineRunConfig) => Promise<{ runId: string }>)
      | undefined;
    if (!scanCorpus || !startRun) return;
    try {
      const scanConfig = await scanCorpus(selectedProject.inputPath, {
        projectId: selectedProject.id,
      });
      const runResult = await startRun(scanConfig);
      setSelectedRunId(runResult.runId);
      setActiveProjectId(selectedProject.id);
      setActiveScreen("runs");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start run";
      globalThis.alert(message);
    }
  };
  const handleOpenProject = (projectId: string): void => {
    setActiveProjectId(projectId);
    setActiveScreen("runs");
  };

  const commands: Array<{
    id: string;
    label: string;
    category: string;
    shortcut?: string;
    action: () => void;
  }> = [
    {
      id: "nav-projects",
      label: "Go to Projects",
      category: "Navigation",
      shortcut: "Ctrl+1",
      action: (): void => setActiveScreen("projects"),
    },
    {
      id: "nav-runs",
      label: "Go to Run History",
      category: "Navigation",
      shortcut: "Ctrl+2",
      action: (): void => setActiveScreen("runs"),
    },
    {
      id: "nav-monitor",
      label: "Go to Live Monitor",
      category: "Navigation",
      shortcut: "Ctrl+3",
      action: (): void => setActiveScreen("monitor"),
    },
    {
      id: "nav-review",
      label: "Go to Review Queue",
      category: "Navigation",
      shortcut: "Ctrl+4",
      action: (): void => setActiveScreen("review"),
    },
    {
      id: "nav-exports",
      label: "Go to Exports",
      category: "Navigation",
      shortcut: "Ctrl+5",
      action: (): void => setActiveScreen("exports"),
    },
    {
      id: "nav-settings",
      label: "Go to Settings",
      category: "Navigation",
      shortcut: "Ctrl+6",
      action: (): void => setActiveScreen("settings"),
    },
    {
      id: "toggle-theme",
      label: "Toggle Theme",
      category: "Preferences",
      action: (): void => setTheme(theme === "light" ? "dark" : "light"),
    },
    {
      id: "import-corpus",
      label: "Import Corpus",
      category: "Actions",
      action: (): void => {
        void handleImportCorpus();
      },
    },
    {
      id: "start-run",
      label: "Start New Run",
      category: "Actions",
      action: (): void => {
        void handleStartRun();
      },
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
            <ProjectsScreen
              onImportCorpus={handleImportCorpus}
              onOpenProject={handleOpenProject}
              onStartRun={handleStartRun}
              projects={projects}
              isLoading={projectsLoading}
              error={projectsError}
            />
          )}
          {activeScreen === "runs" && (
            <RunsScreen
              selectedRunId={selectedRunId}
              onSelectRun={(runId) => setSelectedRunId(runId)}
              onOpenReviewQueue={() => setActiveScreen("review")}
            />
          )}
          {activeScreen === "monitor" && <MonitorScreen />}
          {activeScreen === "review" && <ReviewQueueScreen runId={selectedRunId} />}
          {activeScreen === "exports" && <ExportsScreen />}
          {activeScreen === "settings" && <SettingsScreen projectId={activeProjectId} />}
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
