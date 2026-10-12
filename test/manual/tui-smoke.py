"""Real-terminal smoke test of the codebook review screen inside interactive pi.

    node --experimental-strip-types test/manual/make-paused-run.ts /tmp/idcoder-tui
    python3 test/manual/tui-smoke.py /tmp/idcoder-tui

Starts pi in a pseudo-terminal (POSIX only), opens /idcoder review, renames the first cluster,
approves, declines resuming, and asserts the approval was saved with provenance.
"""

import json
import os
import pty
import re
import select
import struct
import sys
import tempfile
import time

import fcntl
import termios

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CLI = os.path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js")
PROJECT = os.path.abspath(sys.argv[1])
NODE = os.environ.get("NODE", "node")
NEW_LABEL = "Crashes and freezes"


def main() -> None:
    home = tempfile.mkdtemp(prefix="idcoder-tui-home-")
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(PROJECT)
        env = dict(os.environ, HOME=home, PI_CODING_AGENT_DIR=f"{home}/.pi/agent", TERM="xterm-256color")
        os.execvpe(NODE, [NODE, CLI, "-e", ROOT, "--offline", "--no-session", "--tui-mode", "regular"], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 110, 0, 0))
    output = bytearray()

    def pump(seconds: float) -> None:
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([fd], [], [], 0.1)
            if fd in ready:
                try:
                    chunk = os.read(fd, 65536)
                except OSError:
                    return
                output.extend(chunk)
                if b"\x1b[6n" in chunk:
                    os.write(fd, b"\x1b[1;1R")

    def send(keys: str, wait: float = 1.5) -> None:
        for key in keys:
            os.write(fd, key.encode())
            time.sleep(0.04)
        pump(wait)

    def screen() -> str:
        text = output.decode("utf8", "replace")
        return re.sub(r"\x1b\[[0-9;?<>=]*[A-Za-z~]|\x1b\][^\x07]*\x07", " ", text)

    try:
        pump(8)
        send("/idcoder review", 1)
        send("\r", 1.5)  # accept the autocomplete suggestion
        send("\r", 4)  # submit the command
        assert "Codebook review" in screen(), "review screen did not open"
        send("r", 2)
        send(NEW_LABEL, 0.5)
        send("\r", 3)
        assert f'Renamed to "{NEW_LABEL}"' in screen(), "rename was not applied"
        send("a", 2)
        send("\r", 3)  # Yes: approve
        send("\x1b[B", 0.5)
        send("\r", 3)  # No: do not resume now
    finally:
        os.kill(pid, 9)

    approval = json.load(open(os.path.join(PROJECT, ".idcoder", "runs", "tui", "data", "codebook_v2.json")))
    sources = {entry["label"]: entry["source"] for entry in approval["clusters"].values()}
    assert sources.get(NEW_LABEL) == "llm+edited", sources
    print("TUI smoke test passed:", sources)


if __name__ == "__main__":
    main()
