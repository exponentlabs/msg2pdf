from __future__ import annotations

import html
import re
import tempfile
import json
import sys
from dataclasses import asdict
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote

from .models import EmailMessage
from .html_safety import sanitize_body
from .limits import MAX_BODY_BYTES, MAX_TOTAL_ATTACHMENT_BYTES, RENDER_TIMEOUT, run_bounded
from .paths import native_path


_STYLE_BLOCK_RE = re.compile(r"<style\b[^>]*>.*?</style\s*>", re.IGNORECASE | re.DOTALL)
_BODY_BLOCK_RE = re.compile(r"<body\b[^>]*>(.*?)</body\s*>", re.IGNORECASE | re.DOTALL)
_HEAD_BLOCK_RE = re.compile(r"<head\b[^>]*>.*?</head\s*>", re.IGNORECASE | re.DOTALL)
_CID_RE = re.compile(r"cid:(?:<([^>]+)>|([^\s\"'<>()]+))", re.IGNORECASE)


_BASE_CSS = """
@page {
    size: A4;
    margin: 18mm 16mm 18mm;
}

* {
    box-sizing: border-box;
}

html, body {
    margin: 0;
    padding: 0;
}

body {
    color: #202124;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 10.5pt;
    line-height: 1.42;
}

.document-header {
    border-bottom: 1px solid #9aa0a6;
    margin-bottom: 14pt;
    padding-bottom: 10pt;
}

.metadata {
    border-collapse: collapse;
    table-layout: fixed;
    width: 100%;
}

.metadata th,
.metadata td {
    overflow-wrap: anywhere;
    padding: 2pt 0;
    text-align: left;
    vertical-align: top;
}

.metadata th {
    color: #5f6368;
    font-size: 8.5pt;
    font-weight: 700;
    padding-right: 10pt;
    width: 17%;
}

.metadata td {
    color: #202124;
    font-size: 9.5pt;
    width: 83%;
}

.subject {
    color: #111827;
    font-size: 14pt;
    font-weight: 700;
    line-height: 1.25;
    margin: 0 0 8pt;
    overflow-wrap: anywhere;
}

.section-label {
    color: #5f6368;
    font-size: 8.5pt;
    font-weight: 700;
    letter-spacing: 0.04em;
    margin: 0 0 5pt;
    text-transform: uppercase;
}

.email-body {
    overflow-wrap: anywhere;
    overflow: hidden;
}

.email-body img {
    height: auto;
    max-width: 100%;
}

.email-body table {
    max-width: 100%;
}

.plain-body {
    white-space: pre-wrap;
}

.attachments {
    border-top: 1px solid #d2d6da;
    margin-top: 16pt;
    padding-top: 10pt;
}

.attachments ul {
    margin: 0;
    padding-left: 18pt;
}

.attachments li {
    overflow-wrap: anywhere;
}

a {
    overflow-wrap: anywhere;
}
"""


def render_email_to_pdf(message: EmailMessage, output_path: Path) -> None:
    """Render one message to ``output_path`` using an atomic temporary file."""

    output_path = native_path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if len(message.html_body.encode("utf-8")) + len(message.plain_body.encode("utf-8")) > MAX_BODY_BYTES:
        raise ValueError("email body exceeds the 10 MiB size limit")
    payload = json.dumps(asdict(message), ensure_ascii=False)
    if len(payload.encode("utf-8")) > MAX_TOTAL_ATTACHMENT_BYTES:
        raise ValueError("render input exceeds the 128 MiB size limit")

    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb",
            prefix=".render-",
            suffix=".tmp.pdf",
            dir=output_path.parent,
            delete=False,
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)

        with tempfile.TemporaryDirectory(prefix=".render-input-", dir=output_path.parent) as scratch:
            source = Path(scratch) / "message.json"
            source.write_text(payload, encoding="utf-8")
            run_bounded(
                [
                    sys.executable,
                    "-m",
                    "msg2pdf._render_worker",
                    str(source.resolve()),
                    str(temporary_path.resolve()),
                ],
                timeout=RENDER_TIMEOUT,
            )
        temporary_path.replace(output_path)
        temporary_path = None
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def _make_url_fetcher():
    """Allow data URIs while blocking network and filesystem resources."""

    from weasyprint.urls import URLFetcher

    return URLFetcher(allowed_protocols={"data"})


def build_html_document(message: EmailMessage) -> str:
    """Build the self-contained HTML document passed to WeasyPrint."""

    subject = html.escape(message.subject or "(no subject)")
    metadata_rows = [
        _metadata_row("From", message.sender),
        _metadata_row("To", message.recipients),
    ]
    if message.cc.strip():
        metadata_rows.append(_metadata_row("Cc", message.cc))
    metadata_rows.extend(
        [
            _metadata_row("Sent", message.sent_at),
            _metadata_row("Subject", message.subject),
        ]
    )

    body_html = _render_body(message)
    attachment_html = _render_attachments(message.attachments)

    return f"""<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>{subject}</title>
    <style>{_BASE_CSS}</style>
</head>
<body>
    <header class="document-header">
        <h1 class="subject">{subject}</h1>
        <table class="metadata">
            <tbody>
                {"".join(metadata_rows)}
            </tbody>
        </table>
    </header>
    <main>
        <p class="section-label">Message</p>
        <section class="email-body">{body_html}</section>
        {attachment_html}
    </main>
</body>
</html>
"""


def _metadata_row(label: str, value: str) -> str:
    return f'<tr><th scope="row">{html.escape(label)}</th><td>{html.escape(value.strip())}</td></tr>'


def _render_body(message: EmailMessage) -> str:
    if message.has_html_body:
        return _prepare_html_body(message.html_body, message.inline_images)
    if message.plain_body.strip():
        return f'<div class="plain-body">{html.escape(message.plain_body)}</div>'
    return '<p class="plain-body">(empty message body)</p>'


def normalize_content_id(value: str) -> str:
    """Use the same CID matching rules for rendering and attachment extraction."""

    return unquote(html.unescape(value)).strip().strip("<>").lower()


def referenced_content_ids(body: str) -> set[str]:
    """Find inline resources referenced by the HTML used in the PDF body."""

    parser = _InlineResourceParser()
    parser.feed(_html_body_fragment(body))
    parser.close()
    return parser.content_ids


class _InlineResourceParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.content_ids: set[str] = set()
        self.in_style = False

    def _add_references(self, value: str) -> None:
        self.content_ids.update(
            normalize_content_id(match.group(1) or match.group(2)) for match in _CID_RE.finditer(value)
        )

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "style":
            self.in_style = True
        for name, value in attrs:
            # A CID download link does not display the attachment's contents.
            if value and (
                name in {"src", "srcset", "background", "poster", "style"}
                or (tag == "object" and name == "data")
                or (tag == "image" and name in {"href", "xlink:href"})
            ):
                self._add_references(value)

    def handle_endtag(self, tag: str) -> None:
        if tag == "style":
            self.in_style = False

    def handle_data(self, data: str) -> None:
        if self.in_style:
            self._add_references(data)


def _html_body_fragment(body: str) -> str:
    styles = "".join(_STYLE_BLOCK_RE.findall(body))
    body_match = _BODY_BLOCK_RE.search(body)
    if body_match:
        fragment = body_match.group(1)
    else:
        fragment = _HEAD_BLOCK_RE.sub("", body)
        fragment = _STYLE_BLOCK_RE.sub("", fragment)

    return f"{styles}{fragment}"


def _prepare_html_body(body: str, inline_images: dict[str, str]) -> str:
    def replace_cid(match: re.Match[str]) -> str:
        key = normalize_content_id(match.group(1) or match.group(2))
        return inline_images.get(key, match.group(0))

    return sanitize_body(_CID_RE.sub(replace_cid, _html_body_fragment(body)))


def _render_attachments(attachments: tuple[str, ...]) -> str:
    if not attachments:
        return ""
    items = "".join(f"<li>{html.escape(name)}</li>" for name in attachments)
    return f'<section class="attachments"><p class="section-label">Attachments</p><ul>{items}</ul></section>'
