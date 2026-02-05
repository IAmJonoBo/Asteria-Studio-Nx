from __future__ import annotations

import json
import os
import sys
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Optional

try:
    from rich.progress import (
        BarColumn,
        Progress,
        TaskID,
        TextColumn,
        TimeElapsedColumn,
        TimeRemainingColumn,
    )

    _RICH_AVAILABLE = True
except Exception:  # pragma: no cover - fallback
    _RICH_AVAILABLE = False


ROOT = Path(__file__).resolve().parents[2]


def _timestamp() -> str:
    return time.strftime("%H:%M:%S", time.localtime())


def _format_duration(ms: int) -> str:
    if ms < 1000:
        return f"{ms}ms"
    seconds = ms / 1000
    if seconds < 60:
        return f"{seconds:.2f}s"
    minutes = int(seconds // 60)
    remainder = seconds - minutes * 60
    return f"{minutes}m {remainder:.1f}s"


@dataclass
class PhaseHandle:
    reporter: "RunReporter"
    name: str
    total: Optional[int]

    def start(self) -> None:
        self.reporter._start_phase(self.name, self.total)

    def tick(self, amount: int = 1, attrs: Optional[dict] = None) -> None:
        self.reporter._tick(self.name, amount, self.total, attrs)

    def set(
        self, current: int, total: Optional[int] = None, attrs: Optional[dict] = None
    ) -> None:
        self.reporter._set(self.name, current, total, attrs)

    def end(self, status: str = "ok") -> None:
        self.reporter._end_phase(self.name, status)

    def __enter__(self) -> "PhaseHandle":
        self.start()
        return self

    def __exit__(self, exc_type, exc, _tb) -> None:
        if exc_type:
            self.reporter._end_phase(self.name, "fail")
        else:
            self.reporter._end_phase(self.name, "ok")


class RunReporter:
    def __init__(
        self,
        tool: str,
        run_id: str,
        output_dir: Optional[Path] = None,
        extra_output_paths: Optional[Iterable[Path]] = None,
        min_progress_interval_s: float = 0.1,
        enable_console: bool = True,
    ) -> None:
        self.tool = tool
        self.run_id = run_id
        self.base_dir = output_dir or (ROOT / "artifacts" / "observability")
        self.output_paths = self._resolve_output_paths(extra_output_paths or [])
        self.min_progress_interval_s = min_progress_interval_s
        self.enable_console = enable_console
        self._last_progress_at: Dict[str, float] = {}
        self._phase_start: Dict[str, float] = {}
        self._phase_total: Dict[str, int] = {}
        self._phase_current: Dict[str, int] = {}
        self._phase_durations: Dict[str, int] = {}
        self._phase_status: Dict[str, str] = {}
        self._warnings: list[str] = []
        self._start_time = time.time()
        self._status = "ok"
        self._progress: Optional[Progress] = None
        self._progress_started = False
        self._tasks: Dict[str, TaskID] = {}

    def _resolve_output_paths(self, extra_output_paths: Iterable[Path]) -> list[Path]:
        main_path = self.base_dir / self.tool / f"{self.run_id}.jsonl"
        paths = [main_path, *extra_output_paths]
        unique: list[Path] = []
        for p in paths:
            if p not in unique:
                unique.append(p)
        for p in unique:
            p.parent.mkdir(parents=True, exist_ok=True)
        return unique

    def _emit(self, event: dict) -> None:
        payload = json.dumps(event, ensure_ascii=False)
        line = payload + "\n"
        for path in self.output_paths:
            with path.open("a", encoding="utf-8") as handle:
                handle.write(line)

    def log_event(
        self,
        kind: str,
        phase: str = "",
        counters: dict | None = None,
        ms: int | None = None,
        attrs: dict | None = None,
    ) -> None:
        event = {
            "eventVersion": "1",
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "runId": self.run_id,
            "tool": self.tool,
            "phase": phase,
            "kind": kind,
            "counters": counters,
            "ms": ms,
            "attrs": attrs,
        }
        self._emit(event)

    def _ensure_progress(self) -> None:
        if not _RICH_AVAILABLE:
            return
        if self._progress is None:
            self._progress = Progress(
                TextColumn("[progress.description]{task.description}"),
                BarColumn(),
                TextColumn("{task.completed}/{task.total}"),
                TimeElapsedColumn(),
                TimeRemainingColumn(),
                refresh_per_second=10,
            )
        if not self._progress_started:
            self._progress.start()
            self._progress_started = True

    def _get_task(self, phase: str, total: Optional[int]) -> Optional[TaskID]:
        if not _RICH_AVAILABLE:
            return None
        self._ensure_progress()
        if phase not in self._tasks:
            task_id = self._progress.add_task(phase, total=total or 0)
            self._tasks[phase] = task_id
        if total is not None:
            self._progress.update(self._tasks[phase], total=total)
        return self._tasks[phase]

    def phase(self, name: str, total: Optional[int] = None) -> PhaseHandle:
        return PhaseHandle(self, name, total)

    def _start_phase(self, name: str, total: Optional[int]) -> None:
        if name in self._phase_start:
            return
        self._phase_start[name] = time.time()
        if total is not None:
            self._phase_total[name] = total
        self._phase_current[name] = 0
        self._phase_status[name] = "running"
        self.log_event(
            "start",
            phase=name,
            counters={"current": 0, "total": total} if total is not None else None,
        )
        if self.enable_console:
            print(f"{_timestamp()} [start] {name}")

    def _set(
        self, phase: str, current: int, total: Optional[int], attrs: Optional[dict]
    ) -> None:
        now = time.time()
        last = self._last_progress_at.get(phase, 0.0)
        if now - last < self.min_progress_interval_s:
            return
        self._last_progress_at[phase] = now
        self._phase_current[phase] = current
        if total is not None:
            self._phase_total[phase] = total
        self.log_event(
            "progress",
            phase=phase,
            counters=self._maybe_counters(phase),
            attrs=attrs,
        )
        task_id = self._get_task(phase, total)
        if self._progress and task_id is not None:
            self._progress.update(task_id, completed=current)

    def _tick(
        self, phase: str, amount: int, total: Optional[int], attrs: Optional[dict]
    ) -> None:
        current = self._phase_current.get(phase, 0) + amount
        self._set(phase, current, total, attrs)

    def _end_phase(self, phase: str, status: str) -> None:
        if phase not in self._phase_start:
            return
        duration_ms = int((time.time() - self._phase_start[phase]) * 1000)
        self._phase_durations[phase] = duration_ms
        self._phase_status[phase] = status
        if status == "fail":
            self._status = "fail"
        elif status == "warn" and self._status == "ok":
            self._status = "warn"
        self.log_event(
            "end",
            phase=phase,
            ms=duration_ms,
            counters=self._maybe_counters(phase),
        )
        if self.enable_console:
            print(
                f"{_timestamp()} [{status}] {phase} ({_format_duration(duration_ms)})"
            )

    def warning(self, message: str, attrs: Optional[dict] = None) -> None:
        if self._status == "ok":
            self._status = "warn"
        self._warnings.append(message)
        self.log_event(
            "warning", phase="warning", attrs={"message": message, **(attrs or {})}
        )
        if self.enable_console:
            print(f"{_timestamp()} [warn] {message}")

    def error(
        self,
        code: str,
        message: str,
        file: Optional[str] = None,
        line: Optional[int] = None,
        col: Optional[int] = None,
        attrs: Optional[dict] = None,
        exc: Optional[BaseException] = None,
    ) -> None:
        self._status = "fail"
        if exc is not None and (file is None or line is None):
            tb = traceback.extract_tb(exc.__traceback__)
            if tb:
                last = tb[-1]
                file = file or last.filename
                line = line or last.lineno
        file = file or str(Path.cwd() / "UNKNOWN")
        line = int(line or 0)
        col = int(col or 0)
        print(
            f"ASTERIA_ERROR {file}:{line}:{col} {code} {message}",
            file=sys.stderr,
            flush=True,
        )
        self.log_event(
            "error",
            phase="error",
            attrs={
                "code": code,
                "message": message,
                "file": file,
                "line": line,
                "col": col,
                **(attrs or {}),
            },
        )

    def finalize(self, summary: Optional[dict] = None) -> None:
        total_ms = int((time.time() - self._start_time) * 1000)
        self.log_event(
            "metric",
            phase="summary",
            ms=total_ms,
            attrs={
                "status": self._status,
                "phases": self._phase_durations,
                "totals": self._phase_total,
                "warnings": self._warnings,
                **(summary or {}),
            },
        )
        if self.enable_console:
            print("\n----------------------------------------")
            print("ASTERIA OBSERVABILITY SUMMARY")
            print("----------------------------------------")
            print(f"  Status: {self._status.upper()}")
            print(f"  Run ID: {self.run_id}")
            print(f"  Duration: {_format_duration(total_ms)}")
            print(f"  JSONL: {self.output_paths[0] if self.output_paths else 'n/a'}")
            if self._phase_durations:
                print("  Phases:")
                for name, duration in self._phase_durations.items():
                    status = self._phase_status.get(name, "ok")
                    print(f"   - {name}: {status.upper()} {_format_duration(duration)}")
            print("----------------------------------------")
        if self._progress and self._progress_started:
            self._progress.stop()

    def _maybe_counters(self, phase: str) -> Optional[dict]:
        total = self._phase_total.get(phase)
        current = self._phase_current.get(phase)
        if total is None and current is None:
            return None
        return {
            "current": current or 0,
            "total": total or 0,
        }


def create_run_reporter(
    tool: str,
    run_id: Optional[str] = None,
    output_dir: Optional[Path] = None,
    min_progress_interval_s: float = 0.1,
    enable_console: bool = True,
) -> RunReporter:
    resolved_run_id = run_id or f"{tool}-{int(time.time())}"
    if output_dir is None:
        env_dir = os.environ.get("ASTERIA_OBS_DIR")
        if env_dir:
            output_dir = Path(env_dir)
    return RunReporter(
        tool=tool,
        run_id=resolved_run_id,
        output_dir=output_dir,
        extra_output_paths=None,
        min_progress_interval_s=min_progress_interval_s,
        enable_console=enable_console,
    )


__all__ = ["RunReporter", "PhaseHandle", "create_run_reporter"]
