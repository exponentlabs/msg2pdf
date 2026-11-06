"""Keep email formatting within the email body and outside trusted metadata."""

from __future__ import annotations

import html
from html.parser import HTMLParser

import tinycss2

_TAGS = set(
    "a abbr b blockquote br caption code col colgroup dd del div dl dt em h1 h2 h3 h4 h5 h6 hr i img li ol p pre s small span strong sub sup table tbody td tfoot th thead tr u ul".split()
)
_VOID = {"br", "col", "hr", "img"}
_DROP = {"script", "iframe", "template", "noscript"}
_PROPERTIES = set(
    "background background-color background-image background-position background-repeat background-size border border-top border-bottom border-left border-right border-color border-style border-width border-collapse border-spacing color direction display font font-family font-size font-style font-weight height letter-spacing line-height list-style list-style-type max-height max-width min-height min-width overflow-wrap padding padding-top padding-bottom padding-left padding-right text-align text-decoration text-indent text-transform vertical-align white-space width word-break word-spacing".split()
)


def declarations(value: str) -> str:
    accepted = []
    for item in tinycss2.parse_declaration_list(value, skip_comments=True, skip_whitespace=True):
        if item.type != "declaration" or item.lower_name not in _PROPERTIES:
            continue
        serialized = tinycss2.serialize(item.value)
        # Drop legacy CSS expressions and custom-property indirection. The
        # resource fetcher separately rejects non-data resources.
        if any(word in serialized.lower() for word in ("expression(", "var(", "-moz-binding")):
            continue
        accepted.append(f"{item.lower_name}:{serialized}")
    return ";".join(accepted)


def stylesheet(value: str) -> str:
    output = []
    for rule in tinycss2.parse_stylesheet(value, skip_comments=True, skip_whitespace=True):
        if rule.type != "qualified-rule":
            continue  # No @page, @import, @font-face or other document rules.
        selectors, current = [], []
        for token in rule.prelude:
            if token.type == "literal" and token.value == ",":
                selectors.append(tinycss2.serialize(current).strip())
                current = []
            else:
                current.append(token)
        selectors.append(tinycss2.serialize(current).strip())
        css = declarations(tinycss2.serialize(rule.content))
        if css and all(selectors):
            selector = ",".join(".email-body " + part for part in selectors)
            output.append(f"{selector}{{{css}}}")
    # HTML raw-text elements recognise </style even inside a CSS string.
    return "".join(output).replace("<", r"\3c ")


class BodySanitizer(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.output: list[str] = []
        self.stack: list[str] = []
        self.dropped: list[str] = []
        self.style: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        if self.dropped:
            if tag in _DROP:
                self.dropped.append(tag)
            return
        if tag in _DROP:
            self.dropped.append(tag)
            return
        if tag == "style":
            self.style = []
            return
        attributes = dict(attrs)
        if tag in {"object", "image"}:
            attributes["src"] = (
                attributes.get("data") or attributes.get("href") or attributes.get("xlink:href")
            )
            tag = "img"
        if tag not in _TAGS:
            return
        safe = []
        for name, value in attributes.items():
            if value is None:
                continue
            if name == "style":
                value = declarations(value)
            elif name in {"href", "src", "background"}:
                if name != "href" and not value.lower().startswith("data:"):
                    continue
                if name == "href" and not value.lower().startswith(("https://", "http://", "mailto:", "#")):
                    continue
            elif name not in {
                "alt",
                "title",
                "class",
                "id",
                "colspan",
                "rowspan",
                "width",
                "height",
                "align",
                "valign",
                "dir",
            }:
                continue
            safe.append(f' {name}="{html.escape(value, quote=True)}"')
        self.output.append(f"<{tag}{''.join(safe)}>")
        if tag not in _VOID:
            self.stack.append(tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if self.dropped:
            if tag == self.dropped[-1]:
                self.dropped.pop()
            return
        if tag == "style" and self.style is not None:
            self.output.append("<style>" + stylesheet("".join(self.style)) + "</style>")
            self.style = None
        elif tag in self.stack:
            while self.stack:
                closing = self.stack.pop()
                self.output.append(f"</{closing}>")
                if closing == tag:
                    break

    def handle_data(self, data):
        if self.dropped:
            return
        if self.style is not None:
            self.style.append(data)
        else:
            self.output.append(html.escape(data))


def sanitize_body(value: str) -> str:
    parser = BodySanitizer()
    parser.feed(value)
    parser.close()
    parser.output.extend(f"</{tag}>" for tag in reversed(parser.stack))
    return "".join(parser.output)
