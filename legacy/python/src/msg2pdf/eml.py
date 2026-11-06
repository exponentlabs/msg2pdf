from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from email import policy
from email.message import EmailMessage as MimeMessage
from email.parser import BytesParser
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Iterator


@dataclass(frozen=True, slots=True)
class EmlAttachment:
    """Expose MIME parts to the shared attachment and inline-image handling."""

    name: str | None
    data: bytes
    mimetype: str
    emailMessage: MimeMessage


@dataclass(frozen=True, slots=True)
class EmlMessage:
    sender: str
    to: str
    cc: str
    date: datetime | str
    subject: str
    htmlBody: str
    body: str
    attachments: list[EmlAttachment]


def open_eml(input_path: Path) -> EmlMessage:
    with input_path.open("rb") as stream:
        message = BytesParser(policy=policy.default).parse(stream)
    if not message.keys():
        raise ValueError("invalid EML message: no email headers")
    if message.get_content_maintype() == "multipart" and not message.is_multipart():
        raise ValueError("invalid EML message: multipart body could not be parsed")

    candidates = list(_body_candidates(message, body_root=True))
    html_part = next((part for part in candidates if part.get_content_type() == "text/html"), None)
    plain_part = next((part for part in candidates if part.get_content_type() == "text/plain"), None)
    body_parts = {id(part) for part in (html_part, plain_part) if part is not None}

    sent_at = str(message.get("Date", ""))
    try:
        sent_at = parsedate_to_datetime(sent_at)
    except (ValueError, TypeError, OverflowError):
        pass
    return EmlMessage(
        sender=str(message.get("From", "")),
        to=str(message.get("To", "")),
        cc=str(message.get("Cc", "")),
        date=sent_at,
        subject=str(message.get("Subject", "")),
        htmlBody=_decode_text(html_part),
        body=_decode_text(plain_part),
        attachments=list(_attachments(message, body_parts, root=True)),
    )


def _body_candidates(part: MimeMessage, *, body_root: bool = False) -> Iterator[MimeMessage]:
    if part.is_attachment() or (part.get_filename() is not None and not body_root):
        return
    if part.get_content_type() in {"text/html", "text/plain"}:
        yield part
    elif part.get_content_maintype() == "multipart" and part.is_multipart():
        children = list(part.iter_parts())
        if part.get_content_subtype() == "related":
            # Only the related root is the body; its siblings are resources.
            start = part.get_param("start")
            candidate = next(
                (child for child in children if start and child.get("Content-ID") == start), None
            )
            if candidate is None and children:
                candidate = children[0]
            if candidate is not None:
                yield from _body_candidates(candidate, body_root=True)
        else:
            for child in children:
                yield from _body_candidates(child)


def _decode_text(part: MimeMessage | None) -> str:
    if part is None:
        return ""
    data = part.get_payload(decode=True) or b""
    try:
        return data.decode(part.get_content_charset() or "utf-8", errors="replace")
    except LookupError:
        return data.decode("utf-8", errors="replace")


def _attachments(part: MimeMessage, body_parts: set[int], *, root: bool = False) -> Iterator[EmlAttachment]:
    if id(part) in body_parts:
        return
    attached = (
        part.is_attachment() or part.get_filename() is not None or part.get_content_maintype() == "message"
    )
    if not root and attached:
        yield _attachment(part)
    elif part.get_content_maintype() == "multipart" and part.is_multipart():
        for child in part.iter_parts():
            yield from _attachments(child, body_parts)
    elif (
        part.get_content_disposition() is not None
        or part.get("Content-ID")
        or part.get_content_type() not in {"text/plain", "text/html"}
    ):
        yield _attachment(part)


def _attachment(part: MimeMessage) -> EmlAttachment:
    name = part.get_filename()
    if part.get_content_type() in {"message/rfc822", "message/global"}:
        payload = part.get_payload()
        if isinstance(payload, list) and len(payload) == 1:
            data = payload[0].as_bytes(policy=policy.SMTP)
        else:
            raise ValueError("invalid EML attachment: attached email could not be parsed")
        name = name or "attached-email.eml"
    else:
        data = part.get_payload(decode=True)
        if data is None:
            # Preserve a multipart file attachment as one MIME document rather
            # than extracting its children as attachments of the outer email.
            data = part.as_bytes(policy=policy.SMTP)
    return EmlAttachment(name=name, data=data, mimetype=part.get_content_type(), emailMessage=part)
