"""Modal entrypoints. Worker and supervisor are separate functions and images."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

try:
    import modal

    app = modal.App("muselancer")
    hf_cache = modal.Volume.from_name("muselancer-hf-cache", create_if_missing=True)
    image = (
        modal.Image.debian_slim(python_version="3.11")
        .pip_install("llamafirewall")
        .env({"MUSELANCER_REQUIRE_FIREWALL": "1", "HF_HOME": "/root/.cache/huggingface"})
        .add_local_dir(str(ROOT), remote_path="/runtime")
    )

    @app.function(image=image, volumes={"/root/.cache/huggingface": hf_cache}, timeout=300)
    def run_worker(job: dict) -> dict:
        completed = subprocess.run(
            [sys.executable, "/runtime/worker.py"],
            input=json.dumps(job),
            text=True,
            capture_output=True,
            check=False,
        )
        return json.loads(completed.stdout or "{}")

    @app.function(image=image, volumes={"/root/.cache/huggingface": hf_cache}, timeout=300)
    def run_sandbox(job: dict) -> dict:
        completed = subprocess.run(
            [sys.executable, "/runtime/sandbox.py"],
            input=json.dumps(job),
            text=True,
            capture_output=True,
            check=False,
        )
        return json.loads(completed.stdout or "{}")

    @app.function(image=image, volumes={"/root/.cache/huggingface": hf_cache}, timeout=300)
    def run_job(job: dict) -> dict:
        completed = subprocess.run(
            [sys.executable, "/runtime/job_sandbox.py"],
            input=json.dumps(job),
            text=True,
            capture_output=True,
            check=False,
        )
        return json.loads(completed.stdout or "{}")

    @app.function(image=image, volumes={"/root/.cache/huggingface": hf_cache}, timeout=300)
    def run_supervisor(job: dict) -> dict:
        completed = subprocess.run(
            [sys.executable, "/runtime/supervisor.py"],
            input=json.dumps(job),
            text=True,
            capture_output=True,
            check=False,
        )
        return json.loads(completed.stdout or "{}")

except ImportError:
    app = None
    run_worker = None
    run_sandbox = None
    run_job = None
    run_supervisor = None
