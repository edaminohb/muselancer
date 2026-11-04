"""Worker sandbox. It never imports the supervisor and it never settles."""

from __future__ import annotations

import json
import sys

from firewall import scan_text


def main() -> None:
    job = json.loads(sys.stdin.read() or "{}")
    inbound = job.get("instruction", "")
    scan = scan_text(inbound)
    if not scan["allow"]:
        json.dump({"ok": False, "role": "worker", "error": scan["reason"]}, sys.stdout)
        return
    memory = job.get("memory", "")
    artifact = f"Brief from agent {job.get('agentId')}: {memory}".strip()
    artifact_scan = scan_text(artifact, code=True)
    if not artifact_scan["allow"]:
        json.dump({"ok": False, "role": "worker", "error": artifact_scan["reason"]}, sys.stdout)
        return
    json.dump(
        {
            "ok": True,
            "role": "worker",
            "agentId": job.get("agentId"),
            "memoryHead": job.get("memoryHead"),
            "artifact": artifact,
            "checkpoint": f"{memory}\n{artifact}".strip(),
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
