import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Navigation, type NavItem } from "./components/Navigation.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { Icon } from "./components/Icon.js";
import { ProjectsScreen } from "./screens/ProjectsScreen.js";
import { ReviewQueueScreen } from "./screens/ReviewQueueScreen.js";
import { RunsScreen, MonitorScreen, ExportsScreen, SettingsScreen } from "./screens/index.js";
import { useTheme } from "./hooks/useTheme.js";
import { useKeyboardShortcut, useKeyboardShortcuts } from "./hooks/useKeyboardShortcut.js";
import { unwrapIpcResult, unwrapIpcResultOr } from "./utils/ipc.js";
import type {
  AppPreferences,
  IpcResult,
  ProjectSummary,
  PipelineRunConfig,
  RunProgressEvent,
  RunSummary,
} from "../ipc/contracts.js";

const safePrompt = (message: string, defaultValue?: string): string | null => {
  if (typeof globalThis.prompt !== "function") return null;
  try {
    return globalThis.prompt(message, defaultValue);
  } catch {
    return null;
  }
};

export function App(): JSX.Element {
  const [theme, setTheme] = useTheme();
  const [activeScreen, setActiveScreen] = useState<NavItem>("projects");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined);
  const [selectedRunDir, setSelectedRunDir] = useState<string | undefined>(undefined);
  const [activeProjectId, setActiveProjectId] = useState<string | undefined>(undefined);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runProgressById, setRunProgressById] = useState<Record<string, RunProgressEvent>>({});
  const [appPreferences, setAppPreferences] = useState<AppPreferences | null>(null);
  const [onboardingVisible, setOnboardingVisible] = useState(false);
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [importState, setImportState] = useState<{
    status: "idle" | "working" | "success" | "error";
    message?: string;
  }>({ status: "idle" });
  const importResetTimer = useRef<number | null>(null);

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

  const loadProjects = useCallback(async (): Promise<ProjectSummary[]> => {
    const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
      globalThis;
    if (!windowRef.asteria?.ipc) {
      setProjects([]);
      setProjectsLoading(false);
      return [];
    }
    try {
      setProjectsLoading(true);
      const listProjects = windowRef.asteria.ipc["asteria:list-projects"] as
        | (() => Promise<import("../ipc/contracts.js").IpcResult<ProjectSummary[]>>)
        | undefined;
      const data: IpcResult<ProjectSummary[]> = listProjects
        ? await listProjects()
        : { ok: true, value: [] };
      if (!data.ok) {
        setProjects([]);
        setProjectsError(data.error.message);
        return [];
      }
      setProjects(data.value);
      setProjectsError(null);
      return data.value;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load projects";
      setProjectsError(message);
      return [];
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  const loadPreferences = useCallback(async (): Promise<void> => {
    const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
      globalThis;
    if (!windowRef.asteria?.ipc) return;
    const getPreferences = windowRef.asteria.ipc["asteria:get-app-preferences"] as
      | (() => Promise<import("../ipc/contracts.js").IpcResult<AppPreferences>>)
      | undefined;
    if (!getPreferences) return;
    try {
      const prefsResult = await getPreferences();
      if (!prefsResult.ok) return;
      setAppPreferences(prefsResult.value);
      setOnboardingVisible(!prefsResult.value.firstRunComplete);
    } catch (error) {
      console.warn("Failed to load preferences", error);
    }
  }, []);

  const updatePreferences = useCallback(
    async (partial: Partial<AppPreferences>): Promise<AppPreferences | null> => {
      const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
        globalThis;
      if (!windowRef.asteria?.ipc) return null;
      const setPreferences = windowRef.asteria.ipc["asteria:set-app-preferences"] as
        | ((
            prefs: Partial<AppPreferences>
          ) => Promise<import("../ipc/contracts.js").IpcResult<AppPreferences>>)
        | undefined;
      if (!setPreferences) return null;
      const updatedResult = await setPreferences(partial);
      if (!updatedResult.ok) {
        throw new Error(updatedResult.error.message);
      }
      setAppPreferences(updatedResult.value);
      setOnboardingVisible(!updatedResult.value.firstRunComplete);
      return updatedResult.value;
    },
    []
  );

  useEffect(() => {
    void loadProjects();
    void loadPreferences();
  }, [loadPreferences, loadProjects]);

  useEffect((): void | (() => void) => {
    const windowRef: typeof globalThis & {
      asteria?: {
        onRunProgress?: (handler: (event: RunProgressEvent) => void) => () => void;
        ipc?: Record<string, unknown>;
      };
    } = globalThis;
    if (!windowRef.asteria?.onRunProgress) return;
    const unsubscribe = windowRef.asteria.onRunProgress((event): void => {
      setRunProgressById((prev) => ({ ...prev, [event.runId]: event as RunProgressEvent }));
      if (event.stage === "complete" || event.stage === "cancelled" || event.stage === "error") {
        setActiveRunId((current) => (current === event.runId ? null : current));
      } else {
        setActiveRunId(event.runId);
      }
      if (event.stage === "complete") {
        setSelectedRunId(event.runId);
        setSelectedRunDir(undefined);
        const listRuns = windowRef.asteria?.ipc?.["asteria:list-runs"] as
          | (() => Promise<import("../ipc/contracts.js").IpcResult<RunSummary[]>>)
          | undefined;
        if (listRuns) {
          void listRuns()
            .then((runs) => unwrapIpcResultOr(runs, []).find((run) => run.runId === event.runId))
            .then((match) => {
              if (match?.runDir) {
                setSelectedRunDir(match.runDir);
              }
            })
            .catch(() => {
              setSelectedRunDir(undefined);
            });
        }
        setActiveScreen("runs");
      }
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  const activeRunProgress = activeRunId ? runProgressById[activeRunId] ?? null : null;

  const handleImportCorpus = useCallback(
    async (options?: { markFirstRunComplete?: boolean }): Promise<ProjectSummary | null> => {
      const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
        globalThis;
      if (importResetTimer.current) {
        globalThis.clearTimeout(importResetTimer.current);
      }
      setImportState({ status: "working", message: "Opening folder picker..." });
      if (!windowRef.asteria?.ipc) {
        setImportState({
          status: "error",
          message: "IPC bridge unavailable. Restart the app to enable imports.",
        });
        return null;
      }
      const pickCorpusDir = windowRef.asteria.ipc["asteria:pick-corpus-dir"] as
        | (() => Promise<import("../ipc/contracts.js").IpcResult<string | null>>)
        | undefined;
      if (!pickCorpusDir) {
        setImportState({
          status: "error",
          message: "Import is unavailable. IPC channel not registered.",
        });
        return null;
      }
      const importCorpus = windowRef.asteria.ipc["asteria:import-corpus"] as
        | ((request: {
            inputPath: string;
            name?: string;
          }) => Promise<import("../ipc/contracts.js").IpcResult<ProjectSummary>>)
        | undefined;
      if (!importCorpus) {
        setImportState({
          status: "error",
          message: "Import is unavailable. IPC channel not registered.",
        });
        return null;
      }
      try {
        const inputPathResult = await pickCorpusDir();
        const inputPath = unwrapIpcResult(inputPathResult, "Pick corpus");
        if (!inputPath) {
          setImportState({ status: "idle", message: "Import canceled." });
          importResetTimer.current = globalThis.setTimeout(() => {
            setImportState({ status: "idle" });
          }, 3000) as unknown as number;
          return null;
        }
        const rawName = safePrompt("Project name (optional)") ?? "";
        const trimmedName = rawName.trim();
        const name = trimmedName.length > 0 ? trimmedName : undefined;
        const summary = await importCorpus({ inputPath, name });
        const resolved = unwrapIpcResult(summary, "Import corpus");
        await loadProjects();
        if (options?.markFirstRunComplete) {
          await updatePreferences({ firstRunComplete: true });
        }
        setImportState({
          status: "success",
          message: `Imported ${resolved.name ?? "corpus"}.`,
        });
        importResetTimer.current = globalThis.setTimeout(() => {
          setImportState({ status: "idle" });
        }, 4000) as unknown as number;
        return resolved;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to import corpus";
        setImportState({ status: "error", message });
        globalThis.alert(message);
        return null;
      }
    },
    [loadProjects, updatePreferences]
  );

  const handleRevealPath = useCallback(async (targetPath: string): Promise<void> => {
    const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
      globalThis;
    if (!windowRef.asteria?.ipc) return;
    const revealPath = windowRef.asteria.ipc["asteria:reveal-path"] as
      | ((path: string) => Promise<import("../ipc/contracts.js").IpcResult<void>>)
      | undefined;
    if (!revealPath) return;
    const result = await revealPath(targetPath);
    if (!result.ok) throw new Error(result.error.message);
  }, []);

  const handleCreateDiagnosticsBundle = useCallback(async (): Promise<void> => {
    const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
      globalThis;
    if (!windowRef.asteria?.ipc) return;
    const createBundle = windowRef.asteria.ipc["asteria:create-diagnostics-bundle"] as
      | (() => Promise<import("../ipc/contracts.js").IpcResult<{ bundlePath: string }>>)
      | undefined;
    if (!createBundle) return;
    try {
      const bundleResult = await createBundle();
      const { bundlePath } = unwrapIpcResult(bundleResult, "Create diagnostics bundle");
      const clipboard = globalThis.navigator?.clipboard;
      if (clipboard?.writeText) {
        await clipboard.writeText(bundlePath);
      }
      await handleRevealPath(bundlePath);
      globalThis.alert("Diagnostics bundle created. Path copied to clipboard.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to create diagnostics";
      globalThis.alert(message);
    }
  }, [handleRevealPath]);

  const handleProvisionSampleCorpus = async (): Promise<void> => {
    const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
      globalThis;
    if (!windowRef.asteria?.ipc) return;
    const provisionSample = windowRef.asteria.ipc["asteria:provision-sample-corpus"] as
      | (() => Promise<
          import("../ipc/contracts.js").IpcResult<{ projectId: string; inputPath: string }>
        >)
      | undefined;
    if (!provisionSample) return;
    setOnboardingBusy(true);
    setOnboardingError(null);
    try {
      const provisionedResult = await provisionSample();
      const provisioned = unwrapIpcResult(provisionedResult, "Provision sample corpus");
      const updatedProjects = await loadProjects();
      const project =
        updatedProjects.find((item) => item.id === provisioned.projectId) ?? updatedProjects[0];
      await updatePreferences({ firstRunComplete: true, sampleCorpusInstalled: true });
      setOnboardingVisible(false);
      if (project) {
        setActiveProjectId(project.id);
        setActiveScreen("runs");
        await handleStartRun(project);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to provision sample";
      setOnboardingError(message);
    } finally {
      setOnboardingBusy(false);
    }
  };

  const dispatchReviewViewEvent = useCallback(
    (eventName: string): void => {
      if (activeScreen !== "review") {
        setActiveScreen("review");
      }
      globalThis.dispatchEvent(new globalThis.CustomEvent(eventName));
    },
    [activeScreen]
  );

  const handleMenuAction = useCallback(
    (actionId: string): void => {
      switch (actionId) {
        case "app:preferences":
          setActiveScreen("settings");
          break;
        case "file:import-corpus":
          void handleImportCorpus();
          break;
        case "file:export-run":
          setActiveScreen("exports");
          break;
        case "file:open-current-run":
          if (selectedRunDir) {
            void handleRevealPath(selectedRunDir);
          } else {
            globalThis.alert("Select a run to open its folder.");
          }
          break;
        case "view:toggle-overlays":
          dispatchReviewViewEvent("asteria:toggle-overlays");
          break;
        case "view:toggle-guides":
          dispatchReviewViewEvent("asteria:toggle-guides");
          break;
        case "view:toggle-rulers":
          dispatchReviewViewEvent("asteria:toggle-rulers");
          break;
        case "view:toggle-snapping":
          dispatchReviewViewEvent("asteria:toggle-snapping");
          break;
        case "view:reset-view":
          dispatchReviewViewEvent("asteria:reset-view");
          break;
        case "help:open-logs":
          void handleRevealPath("logs");
          break;
        case "help:diagnostics":
          void handleCreateDiagnosticsBundle();
          break;
        case "help:shortcuts":
          globalThis.alert(
            "Keyboard shortcuts:\n\nJ/K = Navigate review queue\nA/F/R = Accept/Flag/Reject\nSpace = Toggle overlays\nG = Toggle guides\nShift+G = Toggle rulers\nS = Toggle snapping\nCtrl/Cmd+K = Command palette"
          );
          break;
        default:
          break;
      }
    },
    [
      dispatchReviewViewEvent,
      selectedRunDir,
      handleImportCorpus,
      handleCreateDiagnosticsBundle,
      handleRevealPath,
    ]
  );

  useEffect((): void | (() => void) => {
    const windowRef: typeof globalThis & {
      asteria?: {
        onMenuAction?: (handler: (actionId: string) => void) => () => void;
      };
    } = globalThis;
    if (!windowRef.asteria?.onMenuAction) return;
    const unsubscribe = windowRef.asteria.onMenuAction(handleMenuAction);
    return () => {
      unsubscribe?.();
    };
  }, [handleMenuAction]);

  const handleStartRun = async (project?: ProjectSummary): Promise<void> => {
    if (activeRunId) {
      setActiveScreen("monitor");
      globalThis.alert(
        "A run is already in progress. Cancel it in Live Monitor before starting a new run."
      );
      return;
    }
    const selectedProject =
      project ?? projects.find((item) => item.id === activeProjectId) ?? projects[0];
    if (!selectedProject) {
      globalThis.alert("Select a project to start a run.");
      return;
    }
    const parsePromptNumber = (value: string | null, fallback: number): number => {
      const trimmed = (value ?? "").trim();
      if (!trimmed) return fallback;
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? parsed : fallback;
    };
    const windowRef: typeof globalThis & { asteria?: { ipc?: Record<string, unknown> } } =
      globalThis;
    if (!windowRef.asteria?.ipc) return;
    const scanCorpus = windowRef.asteria.ipc["asteria:scan-corpus"] as
      | ((
          rootPath: string,
          options?: { projectId?: string }
        ) => Promise<import("../ipc/contracts.js").IpcResult<PipelineRunConfig>>)
      | undefined;
    const analyzeCorpus = windowRef.asteria.ipc["asteria:analyze-corpus"] as
      | ((config: PipelineRunConfig) => Promise<
          import("../ipc/contracts.js").IpcResult<{
            inferredDimensionsMm?: { width: number; height: number };
            inferredDpi?: number;
            dimensionConfidence?: number;
            dpiConfidence?: number;
            targetDimensionsMm: { width: number; height: number };
            dpi: number;
          }>
        >)
      | undefined;
    const startRun = windowRef.asteria.ipc["asteria:start-run"] as
      | ((config: PipelineRunConfig) => Promise<
          import("../ipc/contracts.js").IpcResult<{
            runId: string;
            runDir: string;
          }>
        >)
      | undefined;
    if (!scanCorpus || !startRun) return;
    try {
      const scanConfigResult = await scanCorpus(selectedProject.inputPath, {
        projectId: selectedProject.id,
      });
      const scanConfig = unwrapIpcResult(scanConfigResult, "Scan corpus");
      let effectiveConfig = scanConfig;
      if (analyzeCorpus) {
        const analysisResult = await analyzeCorpus(scanConfig);
        const analysis = unwrapIpcResult(analysisResult, "Analyze corpus");
        if (analysis.inferredDimensionsMm || analysis.inferredDpi) {
          const inferredDimensions = analysis.inferredDimensionsMm ?? analysis.targetDimensionsMm;
          const inferredDpi = analysis.inferredDpi ?? analysis.dpi;
          const dimensionConfidence = analysis.dimensionConfidence ?? 0;
          const dpiConfidence = analysis.dpiConfidence ?? 0;
          const useInferred = globalThis.confirm(
            `Inferred dimensions: ${inferredDimensions.width} × ${inferredDimensions.height} mm (confidence ${dimensionConfidence.toFixed(
              2
            )})\nInferred DPI: ${Math.round(inferredDpi)} (confidence ${dpiConfidence.toFixed(
              2
            )})\n\nSelect OK to use the inferred settings, or Cancel to override them.`
          );
          if (useInferred) {
            effectiveConfig = {
              ...scanConfig,
              targetDimensionsMm: inferredDimensions,
              targetDpi: inferredDpi,
            };
          } else {
            const widthOverride = safePrompt(
              "Override target width (mm)",
              String(scanConfig.targetDimensionsMm.width)
            );
            const heightOverride = safePrompt(
              "Override target height (mm)",
              String(scanConfig.targetDimensionsMm.height)
            );
            const dpiOverride = safePrompt("Override target DPI", String(scanConfig.targetDpi));
            const parsedWidth = parsePromptNumber(
              widthOverride,
              scanConfig.targetDimensionsMm.width
            );
            const parsedHeight = parsePromptNumber(
              heightOverride,
              scanConfig.targetDimensionsMm.height
            );
            const parsedDpi = parsePromptNumber(dpiOverride, scanConfig.targetDpi);
            effectiveConfig = {
              ...scanConfig,
              targetDimensionsMm: {
                width: parsedWidth,
                height: parsedHeight,
              },
              targetDpi: parsedDpi,
            };
          }
        }
      }
      const runResult = await startRun(effectiveConfig);
      const runPayload = unwrapIpcResult(runResult, "Start run");
      setSelectedRunId(runPayload.runId);
      setSelectedRunDir(runPayload.runDir);
      setActiveProjectId(selectedProject.id);
      setActiveScreen("runs");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start run";
      if (message.toLowerCase().includes("already active")) {
        setActiveScreen("monitor");
      }
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
    {
      id: "view-toggle-guides",
      label: "Toggle Guides",
      category: "View",
      shortcut: "G",
      action: (): void => dispatchReviewViewEvent("asteria:toggle-guides"),
    },
    {
      id: "view-toggle-rulers",
      label: "Toggle Rulers",
      category: "View",
      shortcut: "Shift+G",
      action: (): void => dispatchReviewViewEvent("asteria:toggle-rulers"),
    },
    {
      id: "view-toggle-snapping",
      label: "Toggle Snapping",
      category: "View",
      shortcut: "S",
      action: (): void => dispatchReviewViewEvent("asteria:toggle-snapping"),
    },
    {
      id: "view-reset",
      label: "Reset View",
      category: "View",
      shortcut: "0",
      action: (): void => dispatchReviewViewEvent("asteria:reset-view"),
    },
    {
      id: "diagnostics",
      label: "Create Diagnostics Bundle",
      category: "Help",
      action: (): void => {
        void handleCreateDiagnosticsBundle();
      },
    },
    {
      id: "open-logs",
      label: "Open Logs Folder",
      category: "Help",
      action: (): void => {
        void handleRevealPath("logs");
      },
    },
  ];

  return (
    <div className="app-layout">
      <Navigation
        active={activeScreen}
        onNavigate={setActiveScreen}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
      />

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
            <Icon name={theme === "light" ? "moon" : "sun"} size={16} />
          </button>
        </header>

        <main className="app-content">
          {onboardingVisible && !appPreferences?.firstRunComplete && (
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Welcome to Asteria Studio"
              style={{
                position: "fixed",
                inset: 0,
                zIndex: 1400,
                background: "rgba(4, 8, 20, 0.7)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "24px",
              }}
            >
              <div
                className="card"
                style={{
                  width: "100%",
                  maxWidth: "640px",
                  display: "grid",
                  gap: "16px",
                  padding: "24px",
                }}
              >
                <div>
                  <h2 style={{ margin: 0, fontSize: "22px" }}>Welcome to Asteria Studio</h2>
                  <p style={{ marginTop: "8px", color: "var(--text-secondary)" }}>
                    Start with the bundled sample project or bring your own corpus to begin a run.
                  </p>
                </div>
                {onboardingError && (
                  <div className="card" style={{ borderColor: "var(--color-error)" }}>
                    <strong style={{ color: "var(--color-error)" }}>Setup failed</strong>
                    <p style={{ marginTop: "8px" }}>{onboardingError}</p>
                  </div>
                )}
                <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
                  <button
                    className="btn btn-primary"
                    onClick={() => void handleProvisionSampleCorpus()}
                    disabled={onboardingBusy}
                  >
                    {onboardingBusy ? "Provisioning…" : "Run Sample Project"}
                  </button>
                  <button
                    className="btn btn-secondary"
                    onClick={() => void handleImportCorpus({ markFirstRunComplete: true })}
                    disabled={onboardingBusy}
                  >
                    Import Your Corpus
                  </button>
                </div>
              </div>
            </div>
          )}
          {activeScreen === "projects" && (
            <ProjectsScreen
              onImportCorpus={handleImportCorpus}
              onOpenProject={handleOpenProject}
              onStartRun={handleStartRun}
              projects={projects}
              isLoading={projectsLoading}
              error={projectsError}
              importState={importState}
              activeRunId={activeRunId ?? undefined}
              activeRunProgress={activeRunProgress}
            />
          )}
          {activeScreen === "runs" && (
            <RunsScreen
              selectedRunId={selectedRunId}
              selectedRunDir={selectedRunDir}
              onSelectRun={(runId, runDir) => {
                setSelectedRunId(runId);
                setSelectedRunDir(runDir);
              }}
              onClearSelection={() => {
                setSelectedRunId(undefined);
                setSelectedRunDir(undefined);
              }}
              onOpenReviewQueue={() => setActiveScreen("review")}
              runProgressById={runProgressById}
            />
          )}
          {activeScreen === "monitor" && <MonitorScreen />}
          {activeScreen === "review" && (
            <ReviewQueueScreen runId={selectedRunId} runDir={selectedRunDir} />
          )}
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
