from __future__ import annotations

import base64
import mimetypes
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable

import extract_msg
from bs4 import UnicodeDammit

from .attachments import save_attachments
from .eml import open_eml
from .formats import OFFICE_EXTENSIONS
from .models import EmailMessage
from .office import convert_office_to_pdf, copy_pdf
from .renderer import normalize_content_id, referenced_content_ids
from .limits import MAX_ATTACHMENT_BYTES, MAX_BODY_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, check_input
from .paths import native_path


def convert_file(
    input_path: Path,
    output_path: Path,
    *,
    overwrite: bool = False,
    extract_attachments: bool = False,
    all_to_pdf: bool = False,
    reserved_names: Iterable[str] = (),
) -> bool:
    """Convert one file and return ``True`` when a PDF was written.

    A return value of ``False`` means the destination already existed and was
    intentionally skipped. Requested attachments are still extracted in that
    case. Failures are raised so the batch layer can report them and continue.
    """

    input_path, output_path = native_path(input_path), native_path(output_path)
    check_input(input_path)
    if input_path.resolve() == output_path.resolve():
        if all_to_pdf and input_path.suffix.lower() == ".pdf":
            return False
        raise ValueError("output must not replace the source file")
    if extract_attachments and input_path.resolve().is_relative_to(output_path.parent.resolve()):
        raise ValueError("attachment output requires a separate output directory")
    if output_path.is_symlink():
        raise OSError(f"output path is a symlink: {output_path}")
    if all_to_pdf:
        if input_path.suffix.lower() == ".pdf":
            return copy_pdf(input_path, output_path, overwrite=overwrite)
        if input_path.suffix.lower() in OFFICE_EXTENSIONS:
            return convert_office_to_pdf(input_path, output_path, overwrite=overwrite)

    skip_pdf = False
    if output_path.exists():
        if not output_path.is_file():
            raise OSError(f"output path is not a file: {output_path}")
        if not overwrite:
            if not extract_attachments:
                return False
            skip_pdf = True

    message = extract_message(
        input_path,
        attachment_prefix=output_path.with_suffix("") if extract_attachments else None,
        overwrite=overwrite,
        all_to_pdf=all_to_pdf,
        reserved_names=reserved_names,
        render_body=not skip_pdf,
    )
    if skip_pdf:
        return False
    # Import WeasyPrint only when a conversion is actually requested. This
    # keeps --help, path validation, and skipped files usable without loading
    # WeasyPrint's platform-specific native rendering libraries.
    from .renderer import render_email_to_pdf

    render_email_to_pdf(message, output_path)
    return True


def extract_message(
    input_path: Path,
    *,
    attachment_prefix: Path | None = None,
    overwrite: bool = False,
    all_to_pdf: bool = False,
    reserved_names: Iterable[str] = (),
    render_body: bool = True,
) -> EmailMessage:
    """Read a MSG or EML file, optionally saving its non-inline attachments."""

    input_path = native_path(input_path)
    check_input(input_path)
    message_file = (
        open_eml(input_path) if input_path.suffix.lower() == ".eml" else extract_msg.openMsg(str(input_path))
    )
    try:
        raw_attachments = _read_value(message_file, "attachments") or []
        raw_html = _read_value(message_file, "htmlBody")
        html_body = (
            (UnicodeDammit(raw_html, is_html=True).unicode_markup or "")
            if isinstance(raw_html, bytes)
            else _as_text(raw_html)
        )
        if len(html_body.encode("utf-8")) > MAX_BODY_BYTES:
            raise ValueError("email body exceeds the 10 MiB size limit")
        body_content_ids = referenced_content_ids(html_body)
        attachment_names: list[str] = []
        inline_images: dict[str, str] = {}
        file_attachments: list[Any] = []
        file_attachment_names: list[str] = []
        attachment_bytes = 0

        for attachment in raw_attachments:
            filename = _attachment_filename(attachment)
            attachment_names.append(filename)
            data = _read_value(attachment, "data")
            if isinstance(data, (bytes, bytearray, memoryview)):
                attachment_bytes += len(data)
                if len(data) > MAX_ATTACHMENT_BYTES or attachment_bytes > MAX_TOTAL_ATTACHMENT_BYTES:
                    raise ValueError("attachments exceed size limits (64 MiB each, 128 MiB total)")
            if render_body and _attachment_content_id(attachment) in body_content_ids:
                _add_inline_image(attachment, inline_images)
            if attachment_prefix is not None and not _is_inline_attachment(attachment, body_content_ids):
                file_attachments.append(attachment)
                file_attachment_names.append(filename)

        message = EmailMessage(
            sender=_as_text(_read_value(message_file, "sender")),
            recipients=_as_text(_read_value(message_file, "to")),
            cc=_as_text(_read_value(message_file, "cc")),
            sent_at=_format_date(_read_value(message_file, "date")),
            subject=_as_text(_read_value(message_file, "subject")),
            html_body=html_body,
            plain_body=_as_text(_read_value(message_file, "body")),
            attachments=tuple(attachment_names),
            inline_images=inline_images,
        )
        if attachment_prefix is not None:
            save_attachments(
                file_attachments,
                file_attachment_names,
                attachment_prefix,
                overwrite=overwrite,
                all_to_pdf=all_to_pdf,
                reserved_names=reserved_names,
            )
        return message
    finally:
        close = getattr(message_file, "close", None)
        if callable(close):
            close()


def _read_value(obj: Any, name: str) -> Any:
    try:
        value = getattr(obj, name)
    except AttributeError:
        return None
    if callable(value):
        return value()
    return value


def _attachment_filename(attachment: Any) -> str:
    # The parser's name property also supplies the .msg extension for embedded
    # emails. Avoid getFilename(), which invents random names for unnamed files.
    for name in (
        "name",
        "longFilename",
        "shortFilename",
        "displayName",
        "filename",
    ):
        value = _read_value(attachment, name)
        text = _as_text(value).strip()
        if text:
            return text
    return "(unnamed attachment)"


def _attachment_content_id(attachment: Any) -> str:
    for name in ("cid", "contentId", "contentID", "content_id"):
        value = _read_value(attachment, name)
        if value:
            return normalize_content_id(_as_text(value))
    # Signed MSG attachments expose MIME headers rather than CID properties.
    mime_message = _read_value(attachment, "emailMessage")
    if mime_message is not None:
        return normalize_content_id(_as_text(mime_message.get("Content-ID")))
    return ""


def _is_inline_attachment(attachment: Any, body_content_ids: set[str]) -> bool:
    if _read_value(attachment, "hidden"):
        return True
    content_id = _attachment_content_id(attachment)
    if content_id and content_id in body_content_ids:
        return True
    mime_message = _read_value(attachment, "emailMessage")
    return mime_message is not None and mime_message.get_content_disposition() == "inline"


def _add_inline_image(attachment: Any, inline_images: dict[str, str]) -> None:
    content_id = _attachment_content_id(attachment)
    if not content_id:
        return

    data = _read_value(attachment, "data")
    if data is None:
        for name in ("getData", "get_data"):
            try:
                data = _read_value(attachment, name)
            except Exception:
                data = None
            if data is not None:
                break
    if not isinstance(data, (bytes, bytearray, memoryview)):
        return

    filename = _attachment_filename(attachment)
    content_type = (
        _as_text(
            _read_value(attachment, "mimetype")
            or _read_value(attachment, "mimeType")
            or _read_value(attachment, "contentType")
        )
        .split(";", 1)[0]
        .strip()
    )
    if not content_type:
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"

    encoded = base64.b64encode(bytes(data)).decode("ascii")
    inline_images[content_id] = f"data:{content_type};base64,{encoded}"


def _as_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _format_date(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        format_string = "%Y-%m-%d %H:%M:%S"
        if value.tzinfo is not None:
            format_string += " %z"
        return value.strftime(format_string)
    if isinstance(value, date):
        return value.isoformat()
    return _as_text(value).strip()
