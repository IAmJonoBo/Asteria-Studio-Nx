import { useMemo } from "react";

export function App(): JSX.Element {
  const summary = useMemo(
    () => [
      "Deskew & dewarp with confidence scoring",
      "Detect bounds, titles, folios, ornaments, body blocks",
      "Normalize to target dimensions/DPI with bleed/trim",
      "Offline-first with optional remote accelerators",
      "Review queue with overlays and bulk actions",
    ],
    []
  );

  return (
    <main className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Asteria Studio</p>
          <h1>Enterprise page normalization</h1>
          <p className="lede">
            Offline-first Electron desktop app for designers and digitization teams. Ingest scans,
            deskew, dewarp, detect elements, and export audit-ready outputs.
          </p>
          <div className="pill-row">
            <span className="pill">Local projects</span>
            <span className="pill">GPU-aware</span>
            <span className="pill">JSON sidecars</span>
          </div>
        </div>
      </header>
      <section className="panel">
        <h2>Pipeline highlights</h2>
        <ul>
          {summary.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <h2>Next up</h2>
        <p>
          Hook up IPC to the orchestrator, wire the Rust CV core bindings, and add the review queue
          with overlays.
        </p>
      </section>
    </main>
  );
}
