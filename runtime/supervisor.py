"""Supervisor sandbox. Separate process. It cannot see worker memory, only the artifact."""

from __future__ import annotations

import json
import sys

from firewall import scan_text


def main() -> None:
    job = json.loads(sys.stdin.read() or "{}")
    evidence = job.get("evidence", "")
    criteria = job.get("criteria", "")
    scan = scan_text(evidence, code=True)
    if not scan["allow"]:
        json.dump({"ok": True, "role": "supervisor", "verdict": "fail", "reason": scan["reason"]}, sys.stdout)
        return
    if criteria and criteria.lower() not in evidence.lower():
        verdict = "needs_revision"
        reason = "Evidence does not meet the acceptance criteria."
    else:
        verdict = "pass"
        reason = "Evidence meets the acceptance criteria."
    json.dump({"ok": True, "role": "supervisor", "verdict": verdict, "reason": reason}, sys.stdout)


if __name__ == "__main__":
    main()
