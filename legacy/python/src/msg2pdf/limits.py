"""Resource bounds shared by rendering and Office subprocesses."""

from __future__ import annotations

import ctypes
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

MAX_INPUT_BYTES = 100 * 1024 * 1024
MAX_BODY_BYTES = 10 * 1024 * 1024
MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024
MAX_TOTAL_ATTACHMENT_BYTES = 128 * 1024 * 1024
MAX_PDF_BYTES = 256 * 1024 * 1024
MEMORY_BYTES = 1536 * 1024 * 1024
RENDER_TIMEOUT = 60
OFFICE_TIMEOUT = 120
_windows_job = None


def apply_limits() -> None:
    """Fail closed if the operating system cannot enforce worker limits."""
    global _windows_job
    if os.name == "nt":
        from ctypes import wintypes

        class Basic(ctypes.Structure):
            _fields_ = [
                ("process_time", ctypes.c_longlong),
                ("job_time", ctypes.c_longlong),
                ("flags", wintypes.DWORD),
                ("min_working_set", ctypes.c_size_t),
                ("max_working_set", ctypes.c_size_t),
                ("active_processes", wintypes.DWORD),
                ("affinity", ctypes.c_size_t),
                ("priority", wintypes.DWORD),
                ("scheduling", wintypes.DWORD),
            ]

        class Counters(ctypes.Structure):
            _fields_ = [
                (name, ctypes.c_ulonglong)
                for name in ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")
            ]

        class Extended(ctypes.Structure):
            _fields_ = [
                ("basic", Basic),
                ("io", Counters),
                ("process_memory", ctypes.c_size_t),
                ("job_memory", ctypes.c_size_t),
                ("peak_process", ctypes.c_size_t),
                ("peak_job", ctypes.c_size_t),
            ]

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.CreateJobObjectW.restype = wintypes.HANDLE
        kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.SetInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        ]
        kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        job = kernel.CreateJobObjectW(None, None)
        info = Extended()
        # PROCESS_MEMORY | JOB_MEMORY. Do not use KILL_ON_JOB_CLOSE when the
        # worker owns the handle: interpreter shutdown must return normally.
        info.basic.flags = 0x100 | 0x200
        info.process_memory = info.job_memory = MEMORY_BYTES
        if not job or not kernel.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
            raise OSError(ctypes.get_last_error(), "cannot set worker memory limit")
        if not kernel.AssignProcessToJobObject(job, kernel.GetCurrentProcess()):
            raise OSError(ctypes.get_last_error(), "cannot assign worker memory limit")
        _windows_job = job
    else:
        import resource

        bounds = [(resource.RLIMIT_FSIZE, MAX_PDF_BYTES), (resource.RLIMIT_CPU, OFFICE_TIMEOUT)]
        # macOS does not reliably support setrlimit memory caps. The parent
        # monitors resident memory of the entire process tree there instead.
        if sys.platform != "darwin":
            bounds.append((resource.RLIMIT_AS, MEMORY_BYTES))
        for kind, requested in bounds:
            _, hard = resource.getrlimit(kind)
            bound = requested if hard == resource.RLIM_INFINITY else min(requested, hard)
            resource.setrlimit(kind, (bound, bound))


def check_input(path: Path) -> None:
    if path.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError(f"input exceeds the {MAX_INPUT_BYTES // 1024**2} MiB size limit: {path.name}")


def run_bounded(
    command: list[str],
    *,
    timeout: float,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
    memory_bytes: int = MEMORY_BYTES,
) -> None:
    """Bound elapsed time and captured diagnostics, and kill the process tree."""
    import psutil

    with tempfile.TemporaryFile() as diagnostics:
        options = (
            {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
            if os.name == "nt"
            else {"start_new_session": True}
        )
        process = subprocess.Popen(
            command, cwd=cwd, env=env, stdout=diagnostics, stderr=diagnostics, **options
        )
        try:
            monitored = psutil.Process(process.pid)
            deadline = time.monotonic() + timeout
            while process.poll() is None:
                if time.monotonic() >= deadline:
                    raise subprocess.TimeoutExpired(command, timeout)
                try:
                    memory = sum(
                        child.memory_info().rss
                        for child in [monitored, *monitored.children(recursive=True)]
                        if child.is_running()
                    )
                    if memory > memory_bytes:
                        raise RuntimeError("conversion exceeded the worker memory limit")
                except psutil.NoSuchProcess:
                    pass
                if diagnostics.seek(0, 2) > MAX_PDF_BYTES:
                    raise RuntimeError("conversion diagnostics exceeded size limit")
                time.sleep(0.05)
        except BaseException as exc:
            if os.name == "nt":
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(process.pid)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                )
            else:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            process.wait()
            if isinstance(exc, subprocess.TimeoutExpired):
                raise RuntimeError(f"conversion timed out after {timeout:g} seconds") from exc
            raise
        if process.returncode:
            diagnostics.seek(0, 2)
            diagnostics.seek(max(0, diagnostics.tell() - 4000))
            detail = diagnostics.read().decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"conversion worker failed ({process.returncode}): {detail}")


def main() -> int:
    """Limit a child command without unsafe preexec_fn use in the caller."""
    apply_limits()
    command = sys.argv[1:]
    if os.name != "nt":
        os.execvp(command[0], command)
    return subprocess.call(command)


if __name__ == "__main__":
    raise SystemExit(main())
