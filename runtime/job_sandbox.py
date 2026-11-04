"""One hire job. Files stay in a fresh temp directory and the command does not use a shell."""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

MAX_FILES = 200
MAX_CHARS = 64_000
MAX_IMAGE_CHARS = 1_500_000
MAX_IMAGE_BYTES = 1_000_000
MAX_ARGS = 8
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
IMAGE_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}


def safe_join(root: Path, relative: str) -> Path:
    if not relative or relative.startswith(("/", "\\")) or "\\" in relative or "\0" in relative:
        raise ValueError("That path is outside the sandbox.")
    parts = Path(relative).parts
    if any(part in {"", ".", ".."} for part in parts) or len(parts) > 8 or len(relative) > 240:
        raise ValueError("That path is outside the sandbox.")
    candidate = (root / relative).resolve()
    if not candidate.is_relative_to(root.resolve()):
        raise ValueError("That path is outside the sandbox.")
    return candidate


def write_file(root: Path, item: object) -> None:
    if not isinstance(item, dict):
        raise ValueError("That path is outside the sandbox.")
    relative = str(item.get("path") or "")
    text = str(item.get("text") or "")
    path = safe_join(root, relative)
    path.parent.mkdir(parents=True, exist_ok=True)
    if text.startswith("data:image/") and ";base64," in text[:80]:
        if len(text) > MAX_IMAGE_CHARS:
            raise ValueError("A sandbox file is too large.")
        payload = text.split(",", 1)[1]
        raw = base64.b64decode(payload, validate=False)
        if len(raw) > MAX_IMAGE_BYTES:
            raise ValueError("A sandbox file is too large.")
        path.write_bytes(raw)
        return
    if len(text) > MAX_CHARS:
        raise ValueError("A sandbox file is too large.")
    path.write_text(text, encoding="utf-8")


def collect(root: Path) -> list[dict[str, str]]:
    files: list[dict[str, str]] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        relative = path.relative_to(root).as_posix()
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeError:
            suffix = path.suffix.lower()
            if suffix not in IMAGE_EXT:
                continue
            raw = path.read_bytes()
            if len(raw) > MAX_IMAGE_BYTES:
                raise ValueError("A sandbox file is too large.")
            text = f"data:{IMAGE_MIME[suffix]};base64,{base64.b64encode(raw).decode('ascii')}"
        if not text.startswith("data:image/") and len(text) > MAX_CHARS:
            raise ValueError("A sandbox file is too large.")
        files.append({"path": relative, "text": text})
        if len(files) > MAX_FILES:
            raise ValueError("This sandbox is too large.")
    return files


def command_args(value: object) -> list[str]:
    if value in (None, "", []):
        return []
    if not isinstance(value, list) or len(value) > MAX_ARGS:
        raise ValueError("The command is not a program and arguments.")
    args: list[str] = []
    for part in value:
        if not isinstance(part, str) or not part or len(part) > 200 or "\n" in part or "\r" in part or "\0" in part:
            raise ValueError("The command is not a program and arguments.")
        args.append(part)
    return args


def main() -> None:
    job = json.loads(sys.stdin.read() or "{}")
    root = Path(tempfile.mkdtemp(prefix="muselancer-job-"))
    try:
        for item in job.get("files") or []:
            write_file(root, item)
        for item in job.get("writes") or []:
            write_file(root, item)
        args = command_args(job.get("command"))
        stdout = ""
        if args:
            completed = subprocess.run(
                args,
                cwd=root,
                capture_output=True,
                text=True,
                timeout=30,
                shell=False,
                env={"PATH": os.environ.get("PATH", ""), "LANG": "C.UTF-8"},
            )
            stdout = completed.stdout
            if completed.returncode != 0:
                json.dump(
                    {
                        "ok": False,
                        "error": completed.stderr.strip() or "The command did not run.",
                        "stdout": stdout,
                        "files": collect(root),
                    },
                    sys.stdout,
                )
                return
        json.dump({"ok": True, "stdout": stdout, "files": collect(root)}, sys.stdout)
    except Exception as exc:
        files: list[dict[str, str]] = []
        try:
            files = collect(root)
        except Exception:
            files = []
        json.dump({"ok": False, "error": str(exc), "stdout": "", "files": files}, sys.stdout)


if __name__ == "__main__":
    main()
