from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True, slots=True)
class EmailMessage:
    """The message data needed by the PDF renderer."""

    sender: str = ""
    recipients: str = ""
    cc: str = ""
    sent_at: str = ""
    subject: str = ""
    html_body: str = ""
    plain_body: str = ""
    attachments: tuple[str, ...] = field(default_factory=tuple)
    inline_images: dict[str, str] = field(default_factory=dict)

    @property
    def has_html_body(self) -> bool:
        return bool(self.html_body.strip())
