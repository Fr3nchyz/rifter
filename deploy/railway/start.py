#!/usr/bin/env python3
"""Supervise the private API and Railway-facing Rifter gateway."""

from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from urllib.error import URLError
from urllib.request import urlopen


ROOT = Path(os.environ.get("RIFTER_ROOT", "/app"))
UP = ROOT / "upstream/openrift"
GATEWAY_PORT = int(os.environ.get("PORT", "8080"))
CA_FILE = Path(os.environ.get("RIFTER_CA_FILE", "/tmp/supabase-ca.pem"))


def pick_api_port() -> int:
    """Internal API port: never equal to Railway's PORT."""
    configured = int(os.environ.get("RIFTER_API_PORT", "3000"))
    if configured != GATEWAY_PORT:
        return configured
    return 3001 if GATEWAY_PORT != 3001 else 3002


API_PORT = pick_api_port()


def install_database_ca() -> None:
    """If SUPABASE_CA_PEM holds PEM text, trust it for verify-full TLS."""
    pem = os.environ.get("SUPABASE_CA_PEM", "").strip()
    if not pem:
        return
    if "BEGIN CERTIFICATE" not in pem:
        raise RuntimeError("SUPABASE_CA_PEM does not look like PEM text (no BEGIN CERTIFICATE)")
    pem = pem.replace("\\n", "\n")
    CA_FILE.write_text(pem + "\n")
    CA_FILE.chmod(0o600)
    os.environ["PGSSLROOTCERT"] = str(CA_FILE)
    os.environ["NODE_EXTRA_CA_CERTS"] = str(CA_FILE)
    print(f"Database CA installed at {CA_FILE}", flush=True)


def pre_deploy() -> int:
    """Railway pre-deploy: install the CA, then initialise the hosted database."""
    install_database_ca()
    return subprocess.call(
        ["bun", "apps/api/src/modules/rifter/hosted-init.ts", "--catalog-if-empty"], cwd=UP
    )
STARTUP_TIMEOUT = int(os.environ.get("RIFTER_STARTUP_TIMEOUT", "300"))
children: list[tuple[str, subprocess.Popen[bytes]]] = []
stopping = False


def request_catalog(port: int) -> bool:
    try:
        with urlopen(f"http://127.0.0.1:{port}/api/v1/catalog", timeout=5) as response:
            if response.status != 200:
                return False
            catalog = json.load(response)
        return bool(catalog.get("cards")) and bool(catalog.get("printings"))
    except (OSError, URLError, ValueError, AttributeError):
        return False


def ensure_media_link() -> None:
    media = ROOT / ".local/media"
    media.mkdir(parents=True, exist_ok=True)
    native_media = UP / "media"
    if native_media.is_symlink():
        if native_media.resolve() != media.resolve():
            raise RuntimeError(f"Unexpected media symlink: {native_media} -> {native_media.resolve()}")
        return
    if native_media.exists():
        raise RuntimeError(f"Refusing to replace existing native media path: {native_media}")
    native_media.symlink_to(media, target_is_directory=True)


def launch(name: str, command: list[str], port: int) -> subprocess.Popen[bytes]:
    env = os.environ.copy()
    env.update({"RIFTER_ROOT": str(ROOT), "APP_ENV": "production", "PORT": str(port)})
    process = subprocess.Popen(command, cwd=UP, env=env, start_new_session=True)
    children.append((name, process))
    print(f"Started {name} (pid {process.pid})", flush=True)
    return process


def check_children() -> None:
    for name, process in children:
        code = process.poll()
        if code is not None:
            raise RuntimeError(f"{name} exited unexpectedly with status {code}")


def wait_for_catalog(port: int, label: str) -> None:
    deadline = time.monotonic() + STARTUP_TIMEOUT
    while time.monotonic() < deadline:
        if stopping:
            return
        check_children()
        if request_catalog(port):
            print(f"{label} is ready with a populated catalog", flush=True)
            return
        time.sleep(1)
    raise RuntimeError(f"Timed out waiting for populated catalog through {label}")


def stop(_signum: int, _frame: object) -> None:
    global stopping
    stopping = True


def shutdown() -> None:
    deadline = time.monotonic() + 8
    for _name, process in reversed(children):
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    while time.monotonic() < deadline and any(process.poll() is None for _, process in children):
        time.sleep(0.1)
    for _name, process in reversed(children):
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    for _name, process in children:
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass


def main() -> int:
    if "--pre-deploy" in sys.argv:
        return pre_deploy()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        install_database_ca()
        ensure_media_link()
        launch("OpenRift API", ["bun", "apps/api/src/index.ts"], API_PORT)
        wait_for_catalog(API_PORT, "OpenRift API")
        if stopping:
            return 0
        launch(
            "Railway gateway",
            ["bun", "apps/api/src/modules/rifter/backend-proxy.ts"],
            GATEWAY_PORT,
        )
        wait_for_catalog(GATEWAY_PORT, "Railway gateway")
        if stopping:
            return 0
        while not stopping:
            check_children()
            time.sleep(1)
        return 0
    except Exception as error:
        print(f"Railway supervisor failed: {error}", file=sys.stderr, flush=True)
        return 1
    finally:
        shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
