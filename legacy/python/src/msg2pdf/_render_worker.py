"""Private worker; accept only local JSON written by the parent process."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from .limits import MAX_PDF_BYTES, apply_limits


def main() -> None:
    apply_limits()
    from weasyprint import HTML
    from .models import EmailMessage
    from .renderer import _make_url_fetcher, build_html_document

    message = EmailMessage(**json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")))
    output = Path(sys.argv[2])
    HTML(string=build_html_document(message), url_fetcher=_make_url_fetcher()).write_pdf(output)
    if output.stat().st_size > MAX_PDF_BYTES:
        raise ValueError("PDF exceeds output size limit")


if __name__ == "__main__":
    main()
