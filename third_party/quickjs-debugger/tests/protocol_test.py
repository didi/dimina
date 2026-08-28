#!/usr/bin/env python3
"""Build and exercise the QuickJS debugger against a pinned source checkout."""

import argparse
import json
import re
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path


DEBUGGER_DIR = Path(__file__).resolve().parent.parent
DEFAULT_QUICKJS_SOURCE = DEBUGGER_DIR.parent / "quickjs" / "upstream"
SOURCE_PATH = "/__dimina__/test/main/logic.js"


def receive_exact(connection: socket.socket, length: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        chunk = connection.recv(length - len(chunks))
        if not chunk:
            raise RuntimeError("debugger transport closed unexpectedly")
        chunks.extend(chunk)
    return bytes(chunks)


def receive_message(connection: socket.socket) -> dict:
    header = receive_exact(connection, 9)
    if header[8:9] != b"\n":
        raise AssertionError(f"invalid message header: {header!r}")
    payload = receive_exact(connection, int(header[:8], 16))
    if not payload.endswith(b"\n"):
        raise AssertionError("debugger message is missing its trailing newline")
    return json.loads(payload[:-1])


def send_message(connection: socket.socket, message: dict) -> None:
    payload = json.dumps(message, separators=(",", ":")).encode() + b"\n"
    connection.sendall(f"{len(payload):08x}\n".encode() + payload)


def request(connection: socket.socket, sequence: int, command: str, args: dict) -> object:
    send_message(connection, {
        "type": "request",
        "request": {"request_seq": sequence, "command": command, "args": args},
    })
    while True:
        message = receive_message(connection)
        if message.get("type") == "response" and message.get("request_seq") == sequence:
            return message.get("body")


def build_harness(quickjs_source: Path, output_dir: Path) -> Path:
    source_copy = output_dir / "quickjs"
    shutil.copytree(quickjs_source, source_copy, ignore=shutil.ignore_patterns(".git", "*.o"))
    subprocess.run(
        ["git", "apply", str(DEBUGGER_DIR / "patches/quickjs.patch")],
        cwd=source_copy,
        check=True,
    )
    version_file = source_copy / "VERSION"
    if version_file.exists():
        version = version_file.read_text(encoding="utf-8").strip()
    else:
        version_header = (source_copy / "version.h").read_text(encoding="utf-8")
        match = re.search(r'^#define QJS_VERSION "([^"]+)"', version_header, re.MULTILINE)
        if not match:
            raise RuntimeError("QuickJS VERSION or a valid version.h is required")
        version = match.group(1)
    harness = output_dir / "debugger-harness"
    sources = [
        DEBUGGER_DIR / "tests/debugger_harness.c",
        source_copy / "quickjs.c",
        DEBUGGER_DIR / "src/quickjs-debugger.c",
        DEBUGGER_DIR / "src/transport-posix.c",
        source_copy / "libregexp.c",
        source_copy / "libunicode.c",
        source_copy / "cutils.c",
        source_copy / "dtoa.c",
    ]
    subprocess.run([
        "cc", "-std=gnu11", "-O0", "-g", "-D_GNU_SOURCE",
        f'-DCONFIG_VERSION="{version}"',
        "-I", str(source_copy), "-I", str(DEBUGGER_DIR / "include"),
        "-o", str(harness), *(str(source) for source in sources),
        "-lm", "-lpthread",
    ], check=True)
    return harness


def connect_with_retry(port: int) -> socket.socket:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        try:
            return socket.create_connection(("127.0.0.1", port), timeout=1)
        except OSError:
            time.sleep(0.05)
    raise TimeoutError("QuickJS debugger did not start listening")


def run_protocol_test(harness: Path) -> None:
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()

    process = subprocess.Popen([str(harness), f"127.0.0.1:{port}"])
    try:
        with connect_with_retry(port) as connection:
            connection.settimeout(5)
            entry = receive_message(connection)
            assert entry["event"]["reason"] == "entry", entry

            send_message(connection, {
                "type": "breakpoints",
                "breakpoints": {"path": SOURCE_PATH, "breakpoints": [{"line": 2}]},
            })
            send_message(connection, {"type": "continue"})

            while True:
                stopped = receive_message(connection)
                if (stopped.get("type") == "event"
                        and stopped.get("event", {}).get("type") == "StoppedEvent"):
                    break
            assert stopped["event"]["reason"] == "breakpoint", stopped

            stack = request(connection, 1, "stackTrace", {})
            assert stack[0]["filename"] == SOURCE_PATH, stack
            assert stack[0]["line"] == 2, stack

            scopes = request(connection, 2, "scopes", {"frameId": 0})
            local_scope = next(scope for scope in scopes if scope["name"] == "Local")
            variables = request(
                connection, 3, "variables", {"variablesReference": local_scope["reference"]}
            )
            values = {variable["name"]: variable["value"] for variable in variables}
            assert values["a"] == "20" and values["b"] == "22", variables

            evaluated = request(
                connection, 4, "evaluate", {"frameId": 0, "expression": "a + b"}
            )
            assert evaluated["result"] == "42", evaluated
            request(connection, 5, "continue", {})

        if process.wait(timeout=5) != 0:
            raise AssertionError(f"debugger harness exited with {process.returncode}")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "quickjs_source",
        type=Path,
        nargs="?",
        default=DEFAULT_QUICKJS_SOURCE,
        help="QuickJS source directory (default: third_party/quickjs/upstream)",
    )
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="dimina-qjs-debugger-") as temp_dir:
        harness = build_harness(args.quickjs_source.resolve(), Path(temp_dir))
        run_protocol_test(harness)
    print("QuickJS debugger protocol test passed")


if __name__ == "__main__":
    main()
