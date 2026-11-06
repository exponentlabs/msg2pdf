from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import re
from functools import lru_cache
from pathlib import Path

from .limits import OFFICE_TIMEOUT, check_input, run_bounded
from .sandbox import office_command
from .paths import native_path


def _needs_output(output_path: Path, *, overwrite: bool) -> bool:
    if output_path.is_symlink():
        raise OSError(f"output path is a symlink: {output_path}")
    if output_path.exists():
        if not output_path.is_file():
            raise OSError(f"output path is not a file: {output_path}")
        return overwrite
    return True


def find_libreoffice() -> str:
    """Find a system installation, virtualenv command, or explicit override."""

    override = os.environ.get("MSG2PDF_SOFFICE")
    if override:
        command = shutil.which(os.path.expanduser(override))
        if command:
            return command
        raise OSError(f"MSG2PDF_SOFFICE is not an executable: {override}")
    for name in ("soffice", "libreoffice"):
        if command := shutil.which(name):
            return command
    candidates = [
        Path(sys.executable).parent / "soffice",
        Path("/Applications/LibreOffice.app/Contents/MacOS/soffice"),
        Path.home() / "Applications/LibreOffice.app/Contents/MacOS/soffice",
    ]
    for variable in ("PROGRAMFILES", "PROGRAMFILES(X86)"):
        if root := os.environ.get(variable):
            candidates.append(Path(root) / "LibreOffice/program/soffice.exe")
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    raise OSError(
        "LibreOffice is required to convert Office files. Install LibreOffice "
        "(macOS: brew install --cask libreoffice), or set MSG2PDF_SOFFICE to its executable."
    )


@lru_cache(maxsize=16)
def check_libreoffice_version(command: str) -> None:
    result = subprocess.run(
        [command, "--version"], capture_output=True, text=True, errors="replace", timeout=10, check=False
    )
    match = re.search(r"LibreOffice\s+(\d+)\.(\d+)\.(\d+)", result.stdout)
    if result.returncode or not match:
        raise OSError("cannot establish LibreOffice version; install an official supported release")
    version = tuple(map(int, match.groups()))
    if not (version[:2] == (26, 2) and version[2] >= 6 or version >= (26, 8, 1)):
        raise OSError("LibreOffice 26.2.6+ or 26.8.1+ is required for security fixes")


def convert_office_to_pdf(input_path: Path, output_path: Path, *, overwrite: bool = False) -> bool:
    check_input(input_path)
    if not _needs_output(output_path, overwrite=overwrite):
        return False
    command = find_libreoffice()
    check_libreoffice_version(command)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    # Isolate output and profile so a failure cannot replace the final PDF or
    # hand the document to an already running GUI instance.
    with tempfile.TemporaryDirectory(prefix=".office-", dir=output_path.parent) as temporary:
        temporary_root = Path(temporary).resolve()
        converted_dir = temporary_root / "pdf"
        converted_dir.mkdir()
        source = temporary_root / ("document" + input_path.suffix.lower())
        shutil.copyfile(input_path, source)
        profile_path = temporary_root / "profile"
        (profile_path / "user").mkdir(parents=True)
        (profile_path / "user" / "registrymodifications.xcu").write_text(
            '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry">'
            '<item oor:path="/org.openoffice.Office.Common/Security/Scripting">'
            '<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>'
            "</oor:items>",
            encoding="utf-8",
        )
        profile = profile_path.as_uri()
        environment = {
            key: value
            for key, value in os.environ.items()
            if key in {"PATH", "SYSTEMROOT", "WINDIR", "LANG", "LC_ALL", "PYTHONPATH", "VIRTUAL_ENV"}
        }
        environment.update(
            HOME=str(temporary_root),
            TMPDIR=str(temporary_root),
            TEMP=str(temporary_root),
            TMP=str(temporary_root),
            SAL_USE_VCLPLUGIN="svp",
            XDG_CACHE_HOME=str(temporary_root / "cache"),
        )
        arguments = office_command(
            [
                command,
                f"-env:UserInstallation={profile}",
                "--headless",
                "--nologo",
                "--nodefault",
                "--norestore",
                "--convert-to",
                "pdf",
                "--outdir",
                str(converted_dir),
                str(source),
            ],
            temporary_root,
        )
        try:
            run_bounded(
                [sys.executable, "-m", "msg2pdf.limits", *arguments], timeout=OFFICE_TIMEOUT, env=environment
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("Office conversion timed out after 120 seconds") from exc
        converted = converted_dir / "document.pdf"
        if converted.is_symlink() or not converted.is_file() or converted.stat().st_nlink != 1:
            raise RuntimeError("Office conversion failed: no PDF was produced")
        with converted.open("rb") as stream:
            if stream.read(5) != b"%PDF-":
                raise RuntimeError("Office conversion produced an invalid PDF")
        converted.replace(output_path)
    return True


def copy_pdf(input_path: Path, output_path: Path, *, overwrite: bool = False) -> bool:
    input_path, output_path = native_path(input_path), native_path(output_path)
    check_input(input_path)
    if input_path.resolve() == output_path.resolve():
        return False
    if not _needs_output(output_path, overwrite=overwrite):
        return False
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            prefix=".copy-", suffix=".pdf", dir=output_path.parent, delete=False
        ) as stream:
            temporary_path = Path(stream.name)
        shutil.copyfile(input_path, temporary_path)
        temporary_path.replace(output_path)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
    return True
