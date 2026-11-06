"""Fail-closed native Office sandboxing. Windows Office uses WSL."""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path


def office_command(command: list[str], workspace: Path) -> list[str]:
    workspace = workspace.resolve()
    if sys.platform == "darwin":
        sandbox = shutil.which("sandbox-exec")
        if not sandbox:
            raise OSError("Office conversion requires sandbox-exec on macOS")
        installation = Path(command[0]).resolve().parent
        if ".app/" in str(installation):
            installation = Path(str(installation).split(".app/", 1)[0] + ".app")
        reads = [
            Path("/System"),
            Path("/usr"),
            Path("/bin"),
            Path("/sbin"),
            Path("/opt/homebrew"),
            Path("/Library/Fonts"),
            Path("/Library/Application Support/LibreOffice"),
            Path.home() / "Library/Fonts",
            installation,
            workspace,
        ]
        rules = " ".join(f"(subpath {json.dumps(str(path))})" for path in reads)
        profile = (
            "(version 1)(deny default)"
            "(allow process-exec process-fork signal sysctl-read mach-lookup ipc-posix*)"
            "(allow file-read-metadata)"
            f'(allow file-read* {rules} (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))'
            f'(allow file-write* (subpath {json.dumps(str(workspace))}) (literal "/dev/null"))'
        )
        return [sandbox, "-p", profile, *command]
    if sys.platform.startswith("linux"):
        sandbox = shutil.which("bwrap")
        if not sandbox:
            raise OSError("Office conversion requires bubblewrap: install bubblewrap (bwrap)")
        result = [sandbox, "--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL"]
        for name in ("/usr", "/bin", "/sbin", "/lib", "/lib64", "/opt", "/etc/fonts", "/etc/ld.so.cache"):
            if Path(name).exists():
                result.extend(["--ro-bind", name, name])
        # A per-user installation may be mounted alone, never its parent home.
        installation = Path(command[0]).resolve().parent
        if installation.name == "program":
            installation = installation.parent
        if not any(installation.is_relative_to(root) for root in (Path("/usr"), Path("/opt"), Path("/bin"))):
            result.extend(["--ro-bind", str(installation), str(installation)])
        result.extend(
            [
                "--proc",
                "/proc",
                "--dev",
                "/dev",
                "--tmpfs",
                "/tmp",
                "--bind",
                str(workspace),
                str(workspace),
                "--chdir",
                str(workspace),
                *command,
            ]
        )
        return result
    raise OSError(
        "Native Office conversion requires macOS or Linux sandboxing; on Windows use WSL2 with bubblewrap. Email conversion and PDF copying work natively."
    )
