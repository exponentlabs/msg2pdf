from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import pytest
from msg2pdf.paths import native_path


@dataclass
class FakeAttachment:
    longFilename: str | None = None
    shortFilename: str | None = None
    data: bytes | None = None
    cid: str | None = None
    mimetype: str | None = None
    hidden: bool = False


@dataclass
class FakeMessage:
    sender: str = "sender@example.com"
    to: str = "recipient@example.com"
    cc: str = "copy@example.com"
    date: datetime | str | None = field(
        default_factory=lambda: datetime(2026, 9, 15, 10, 30, tzinfo=timezone.utc)
    )
    subject: str = "Example subject"
    htmlBody: str = "<p>Hello <strong>from MSG</strong>.</p>"
    body: str = "Hello from MSG."
    attachments: list[FakeAttachment] = field(default_factory=list)
    closed: bool = False

    def close(self) -> None:
        self.closed = True


@pytest.fixture
def fake_msg_factory(monkeypatch):
    messages: dict[str, FakeMessage | Exception] = {}

    def register(path: Path, message: FakeMessage | Exception) -> None:
        messages[str(native_path(path))] = message
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"not a real MSG; parser is replaced in this test")

    def open_msg(path: str):
        value = messages[path]
        if isinstance(value, Exception):
            raise value
        return value

    monkeypatch.setattr("msg2pdf.converter.extract_msg.openMsg", open_msg)
    return register
