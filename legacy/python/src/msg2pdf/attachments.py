from __future__ import annotations

import re
import tempfile
from pathlib import Path
from typing import Any, Iterable

from .filenames import allocate_output_names
from .formats import OFFICE_EXTENSIONS
from .office import convert_office_to_pdf
from .paths import native_path


def save_attachments(
    attachments: Iterable[Any],
    filenames: Iterable[str],
    prefix: Path,
    *,
    overwrite: bool,
    all_to_pdf: bool = False,
    reserved_names: Iterable[str] = (),
) -> None:
    """Save attachments beside a PDF using stable, unique, safe filenames."""

    prefix = native_path(prefix)
    names: list[str] = []
    for index, filename in enumerate(filenames, start=1):
        # MSG filenames can contain Windows or POSIX paths. Keep only the leaf
        # and remove control characters and characters invalid on Windows.
        name = filename.replace("\\", "/").rsplit("/", 1)[-1]
        name = re.sub(r'[\x00-\x1f\x7f<>:"|?*]', "_", name).strip().rstrip(". ")
        if not name or name == "(unnamed attachment)":
            name = f"attachment-{index}"
        names.append(f"{prefix.name} - {name}")
    output_names = allocate_output_names(
        names,
        convert_extensions=OFFICE_EXTENSIONS if all_to_pdf else set(),
        reserved_names=reserved_names,
    )
    for attachment, source_name, name in zip(attachments, names, output_names, strict=True):
        destination = prefix.parent / name
        if all_to_pdf and Path(source_name).suffix.lower() in OFFICE_EXTENSIONS:
            if not _needs_attachment(destination, overwrite=overwrite):
                continue
            prefix.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix=".attachment-", dir=prefix.parent) as temporary:
                source = Path(temporary) / f"attachment{Path(source_name).suffix}"
                _save_attachment(attachment, source, overwrite=True)
                convert_office_to_pdf(source, destination, overwrite=overwrite)
        else:
            _save_attachment(attachment, destination, overwrite=overwrite)


def _needs_attachment(destination: Path, *, overwrite: bool) -> bool:
    if destination.is_symlink():
        raise OSError(f"attachment output path is a symlink: {destination}")
    if destination.exists():
        if not destination.is_file():
            raise OSError(f"attachment output path is not a file: {destination}")
        if not overwrite:
            return False
    return True


def _save_attachment(attachment: Any, destination: Path, *, overwrite: bool) -> None:
    if not _needs_attachment(destination, overwrite=overwrite):
        return

    data = getattr(attachment, "data", None)
    export = getattr(data, "export", None)
    if not isinstance(data, (bytes, bytearray, memoryview)) and not callable(export):
        raise ValueError(f"attachment data is unavailable or unsupported: {destination.name}")

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", prefix=".attachment-", suffix=".tmp", dir=destination.parent, delete=False
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            if callable(export):
                # Embedded messages must be exported while their parent MSG
                # is still open, preserving the attachment as a .msg file.
                export(temporary_file)
            else:
                temporary_file.write(data)
        temporary_path.replace(destination)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
