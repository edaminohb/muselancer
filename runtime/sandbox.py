"""Workspace sandbox. It mounts one snapshot and refuses a path outside that tree."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path


def safe_join(root: Path, relative: str) -> Path:
    if not relative or relative.startswith(("/", "\\")) or "\\" in relative or "\0" in relative:
        raise ValueError("That path is outside the workspace.")
    parts = Path(relative).parts
    if any(part in {"", ".", ".."} for part in parts):
        raise ValueError("That path is outside the workspace.")
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root.resolve()):
        raise ValueError("That path is outside the workspace.")
    return candidate


def main() -> None:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    job = json.loads(sys.stdin.read() or "{}")
    root = Path(tempfile.mkdtemp(prefix="muselancer-"))
    try:
        for item in job.get("files") or []:
            path = safe_join(root, str(item.get("path") or ""))
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(str(item.get("text") or ""), encoding="utf-8")
        written = []
        for item in job.get("writes") or []:
            relative = str(item.get("path") or "")
            path = safe_join(root, relative)
            path.parent.mkdir(parents=True, exist_ok=True)
            text = str(item.get("text") or "")
            path.write_text(text, encoding="utf-8")
            written.append({"path": relative, "text": text})
        stdout = ""
        entry = job.get("entry")
        if entry:
            script = safe_join(root, str(entry))
            if script.suffix != ".py" or not script.is_file():
                raise ValueError("That script is not an approved entry.")
            completed = subprocess.run(
                [sys.executable, str(script)],
                cwd=root,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            stdout = completed.stdout
            if completed.returncode != 0:
                raise ValueError(completed.stderr.strip() or "The script did not run.")
        json.dump({"ok": True, "stdout": stdout, "files": written}, sys.stdout)
    except Exception as exc:
        json.dump({"ok": False, "error": str(exc), "stdout": "", "files": []}, sys.stdout)


if __name__ == "__main__":
    main()
