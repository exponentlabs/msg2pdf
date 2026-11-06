from __future__ import annotations

import unicodedata
import re
from collections import Counter
from pathlib import Path
from typing import Iterable


def filename_key(name: str) -> str:
    """Treat case and Unicode equivalents as collisions, including on macOS."""

    return unicodedata.normalize("NFC", name).casefold()


def safe_filename(name: str) -> str:
    """Make a leaf portable to Windows, macOS and Linux."""
    name = unicodedata.normalize("NFC", name)
    name = re.sub(r'[\x00-\x1f\x7f<>:"/\\|?*]', "_", name).strip().rstrip(". ")
    if not name or name in {".", ".."}:
        return "unnamed"
    if name.split(".", 1)[0].upper() in {
        "CON",
        "PRN",
        "AUX",
        "NUL",
        "CONIN$",
        "CONOUT$",
        *(f"{prefix}{number}" for prefix in ("COM", "LPT") for number in "123456789¹²³"),
    }:
        name = "_" + name
    return name


def limit_filename(name: str, *, marker: str = "") -> str:
    """Keep the extension and fit within common filesystem filename limits."""

    path = Path(safe_filename(name))
    candidate = f"{path.stem}{marker}{path.suffix}"
    if len(candidate.encode("utf-8")) <= 240:
        return candidate
    suffix = path.suffix.encode("utf-8")[:40].decode("utf-8", errors="ignore")
    budget = 240 - len((marker + suffix).encode("utf-8"))
    stem = path.stem.encode("utf-8")[:budget].decode("utf-8", errors="ignore")
    return stem + marker + suffix


class NameAllocator:
    """Share reservations across all emails in one destination directory."""

    def __init__(self, names: Iterable[str] = ()) -> None:
        self.used = {filename_key(name) for name in names}
        self.next_number: dict[str, int] = {}

    def __iter__(self):
        return iter(self.used)

    def allocate(self, base: str, blocked: set[str]) -> str:
        name = limit_filename(base)
        key = filename_key(name)
        number = self.next_number.get(key, 2)
        while filename_key(name) in self.used or filename_key(name) in blocked:
            name = limit_filename(base, marker=f" ({number})")
            number += 1
        self.next_number[key] = number
        self.used.add(filename_key(name))
        return name


def allocate_output_names(
    names: list[str],
    *,
    convert_extensions: set[str],
    reserved_names: Iterable[str] = (),
    preserve_unconverted: bool = False,
) -> list[str]:
    """Assign stable names without losing same-stem files or existing PDFs."""

    if not names:
        return []
    names = [safe_filename(name) for name in names]
    converting = [Path(name).suffix.lower() in convert_extensions for name in names]
    desired = [
        str(Path(name).with_suffix(".pdf")) if convert else name
        for name, convert in zip(names, converting, strict=True)
    ]
    counts = Counter(filename_key(name) for name in desired)
    unchanged = {filename_key(name) for name, convert in zip(names, converting, strict=True) if not convert}
    allocator = reserved_names if isinstance(reserved_names, NameAllocator) else NameAllocator(reserved_names)
    result = []
    for original, target, convert in zip(names, desired, converting, strict=True):
        # report.docx, report.xlsx and report.pdf must all survive the export.
        base = f"{original}.pdf" if convert and counts[filename_key(target)] > 1 else target
        # Preserve valid long PDF names; converted files use the portable budget.
        if preserve_unconverted and not convert and filename_key(base) not in allocator.used:
            name = base
            allocator.used.add(filename_key(name))
        else:
            name = allocator.allocate(base, unchanged if convert else set())
        result.append(name)
    return result
