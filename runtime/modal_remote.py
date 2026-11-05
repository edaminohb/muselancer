"""Send one sandbox job to the deployed Modal function. This process does not run the job."""

from __future__ import annotations

import json
import sys


def main() -> None:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    job = json.loads(sys.stdin.read() or "{}")
    import modal

    function = modal.Function.from_name("muselancer", "run_sandbox")
    json.dump(function.remote(job), sys.stdout)


if __name__ == "__main__":
    main()
