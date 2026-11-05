"""Purple Llama scan for plaintext only.

Regex always runs. LlamaFirewall adds Prompt Guard 2 for untrusted text and
Code Shield for a deliverable. AlignmentCheck stays off because it sends text
to Together. This module never logs the scanned plaintext.
"""

from __future__ import annotations

import json
import os
import re
import sys

INJECTION = re.compile(r"ignore (all |any )?(prior|previous) instructions", re.I)
SECRET = re.compile(r"LLM_[A-Za-z0-9_]+|BEGIN PRIVATE KEY", re.I)
UNSAFE_CODE = re.compile(r"eval\(|exec\(|subprocess|os\.system", re.I)

_firewall = None
_load_failed = False


def _required() -> bool:
    return os.environ.get("MUSELANCER_REQUIRE_FIREWALL") == "1"


def _regex(text: str) -> dict | None:
    if INJECTION.search(text or ""):
        return {"allow": False, "reason": "Prompt injection pattern.", "llama": "skipped"}
    if SECRET.search(text or ""):
        return {"allow": False, "reason": "Secret material in content.", "llama": "skipped"}
    if UNSAFE_CODE.search(text or ""):
        return {"allow": False, "reason": "CodeShield blocked a dangerous call.", "llama": "skipped"}
    return None


def _load() -> None:
    global _firewall, _load_failed
    if _firewall is not None or _load_failed:
        return
    try:
        from llamafirewall import LlamaFirewall, Role, ScannerType

        _firewall = LlamaFirewall(
            {
                Role.USER: [ScannerType.PROMPT_GUARD],
                Role.TOOL: [ScannerType.PROMPT_GUARD],
                Role.ASSISTANT: [ScannerType.CODE_SHIELD],
            }
        )
    except Exception:
        _load_failed = True
        _firewall = None


def _unavailable() -> dict:
    if _required():
        return {"allow": False, "reason": "LlamaFirewall unavailable", "llama": "unavailable"}
    return {"allow": True, "reason": "Scanner allowed the text.", "llama": "unavailable"}


def _blocked(result: object) -> bool:
    from llamafirewall import ScanDecision

    return getattr(result, "decision", None) == ScanDecision.BLOCK


def scan_text(text: str, code: bool = False) -> dict:
    hit = _regex(text)
    if hit:
        return hit
    _load()
    if _firewall is None:
        return _unavailable()
    try:
        from llamafirewall import AssistantMessage, UserMessage

        message = AssistantMessage(content=text or "") if code else UserMessage(content=text or "")
        result = _firewall.scan(message)
        if _blocked(result):
            reason = "CodeShield blocked the deliverable." if code else "Prompt Guard blocked the text."
            return {"allow": False, "reason": reason, "llama": "block"}
        return {"allow": True, "reason": "Scanner allowed the text.", "llama": "allow"}
    except Exception:
        return _unavailable()


def main() -> None:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    job = json.loads(sys.stdin.read() or "{}")
    json.dump(scan_text(job.get("text", ""), code=job.get("kind") == "code"), sys.stdout)


if __name__ == "__main__":
    main()
