from __future__ import annotations

from pathlib import Path
import os


def native_path(path: Path) -> Path:
    """Use Windows extended paths so deep exports do not need registry changes."""
    if os.name != "nt":
        return path
    absolute = os.path.abspath(path)
    if absolute.startswith("\\\\?\\"):
        return Path(absolute)
    if absolute.startswith("\\\\"):
        return Path("\\\\?\\UNC\\" + absolute[2:])
    return Path("\\\\?\\" + absolute)


def validate_destination(path: Path, root: Path) -> None:
    """Reject links and Windows junctions beneath a trusted output root."""
    root = root.resolve()
    absolute = path.absolute()
    try:
        relative = absolute.relative_to(root)
    except ValueError as exc:
        raise OSError(f"output path escapes output directory: {path}") from exc
    current = root
    for part in relative.parts:
        current /= part
        if current.is_symlink() or current.is_junction():
            raise OSError(f"output path contains a symlink or junction: {current}")
    if not absolute.resolve().is_relative_to(root):
        raise OSError(f"output path escapes output directory: {path}")
