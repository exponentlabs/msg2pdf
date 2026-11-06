from __future__ import annotations

import base64
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser

import pytest
from pypdf import PdfReader

from msg2pdf.cli import main
from msg2pdf.converter import extract_message
from tests.conftest import FakeMessage


IMAGE_DATA = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6360f8cf00000101000118dd8db40000000049454e44ae426082"
)


def email(subject="Résumé – email", body="Hello from EML."):
    message = EmailMessage()
    message["From"] = "Zoë Sender <sender@example.com>"
    message["To"] = "Recipient <recipient@example.com>"
    message["Cc"] = "copy@example.com"
    message["Date"] = "Tue, 15 Sep 2026 10:30:00 +0100"
    message["Subject"] = subject
    message.set_content(body)
    return message


def write_eml(path, message):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(message.as_bytes(policy=policy.SMTP))
    return path


def run(source, output, *options):
    return main(["--input", str(source), "--output", str(output), *options])


def pdf_text(path):
    return "\n".join(page.extract_text() or "" for page in PdfReader(path).pages)


@pytest.mark.parametrize("extension", [".eml", ".EML"])
def test_single_eml_preserves_metadata_unicode_and_plain_body(tmp_path, extension):
    source = write_eml(tmp_path / f"Café résumé{extension}", email())
    output = tmp_path / "pdf"

    assert run(source, output) == 0
    text = pdf_text(output / "Café résumé.pdf")
    for expected in (
        "Zoë Sender",
        "sender@example.com",
        "recipient@example.com",
        "copy@example.com",
        "2026-09-15 10:30:00 +0100",
        "Résumé – email",
        "Hello from EML.",
    ):
        assert expected in text


def test_multipart_html_is_preferred_and_attachment_text_does_not_become_body(tmp_path):
    message = email(body="PLAIN ALTERNATIVE")
    message.add_alternative("<p>HTML <strong>message body</strong></p>", subtype="html")
    message.add_attachment(b"PRIVATE ATTACHMENT TEXT", maintype="text", subtype="plain", filename="notes.txt")
    source = write_eml(tmp_path / "email.eml", message)
    output = tmp_path / "pdf"

    assert run(source, output) == 0
    text = pdf_text(output / "email.pdf")
    assert "HTML message body" in text
    assert "PLAIN ALTERNATIVE" not in text
    assert "PRIVATE ATTACHMENT TEXT" not in text
    assert "notes.txt" in text
    assert list(output.iterdir()) == [output / "email.pdf"]


@pytest.mark.parametrize("transfer_encoding", ["base64", "quoted-printable", "8bit"])
def test_declared_text_charset_and_transfer_encoding_are_decoded(tmp_path, transfer_encoding):
    message = email()
    message.set_content("Café résumé £", charset="windows-1252", cte=transfer_encoding)
    source = write_eml(tmp_path / "email.eml", message)

    assert extract_message(source).plain_body.strip() == "Café résumé £"


def test_unknown_charset_uses_utf8_fallback_and_invalid_date_is_preserved(tmp_path):
    source = tmp_path / "email.eml"
    source.write_bytes(
        b"Subject: Unknown charset\r\nDate: not a date\r\n"
        b'Content-Type: text/plain; charset="x-unknown-charset"\r\n'
        b"Content-Transfer-Encoding: base64\r\n\r\n" + base64.b64encode("Café résumé".encode())
    )

    message = extract_message(source)
    assert message.plain_body == "Café résumé"
    assert message.sent_at == "not a date"


def test_binary_unicode_and_empty_attachments_are_extracted_exactly(tmp_path):
    message = email()
    message.add_attachment(
        b"\x00\xffbinary\r\n", maintype="application", subtype="octet-stream", filename="résumé.bin"
    )
    message.add_attachment(b"", maintype="text", subtype="plain", filename="empty.txt")
    source = write_eml(tmp_path / "email.eml", message)
    output = tmp_path / "pdf"

    assert run(source, output, "--extract-attachments") == 0
    assert (output / "email - résumé.bin").read_bytes() == b"\x00\xffbinary\r\n"
    assert (output / "email - empty.txt").read_bytes() == b""


def test_inline_resources_stay_in_pdf_and_ordinary_attached_photos_are_saved(tmp_path):
    message = email()
    message.add_alternative('<p>Hello</p><img src="CID:Logo%40Example">', subtype="html")
    html_part = message.get_payload()[-1]
    html_part.add_related(
        IMAGE_DATA, maintype="image", subtype="png", cid="<logo@example>", filename="signature.png"
    )
    signature = html_part.get_payload()[-1]
    del signature["Content-Disposition"]
    signature.set_param("name", "signature.png")
    message.add_attachment(IMAGE_DATA, maintype="image", subtype="png", filename="photo.png")
    message.add_attachment(
        IMAGE_DATA, maintype="image", subtype="png", filename="unused-inline.png", disposition="inline"
    )
    source = write_eml(tmp_path / "email.eml", message)
    output = tmp_path / "pdf"

    assert run(source, output, "--extract-attachments") == 0
    assert any(page.images for page in PdfReader(output / "email.pdf").pages)
    assert (output / "email - photo.png").read_bytes() == IMAGE_DATA
    assert {path.name for path in output.iterdir()} == {"email.pdf", "email - photo.png"}


def test_related_start_selects_named_body_after_inline_resources(tmp_path):
    message = email()
    message.clear_content()
    message.set_type("multipart/related")
    message.set_param("start", "<body@example>")
    image = EmailMessage()
    image.set_content(IMAGE_DATA, maintype="image", subtype="png")
    image["Content-ID"] = "<logo@example>"
    message.attach(image)
    body = EmailMessage()
    body.set_content('<p>Related body</p><img src="cid:logo@example">', subtype="html")
    body.set_param("name", "message-body.html")
    body["Content-ID"] = "<body@example>"
    message.attach(body)
    source = write_eml(tmp_path / "email.eml", message)

    parsed = extract_message(source, attachment_prefix=tmp_path / "pdf" / "email")
    assert "Related body" in parsed.html_body
    assert "logo@example" in parsed.inline_images
    assert "message-body.html" not in parsed.attachments
    assert not (tmp_path / "pdf").exists()


def test_named_text_without_disposition_is_an_attachment(tmp_path):
    message = email(body="Actual message body")
    message.add_attachment(b"Attached text", maintype="text", subtype="plain", filename="notes.txt")
    attachment = message.get_payload()[-1]
    attachment.set_param("name", "notes.txt")
    del attachment["Content-Disposition"]
    message.add_attachment(b"<p>Attached HTML</p>", maintype="text", subtype="html", filename="page.html")
    source = write_eml(tmp_path / "email.eml", message)
    output = tmp_path / "pdf"

    assert run(source, output, "--extract-attachments") == 0
    assert "Actual message body" in pdf_text(output / "email.pdf")
    assert "Attached HTML" not in pdf_text(output / "email.pdf")
    assert (output / "email - notes.txt").read_bytes() == b"Attached text"
    assert (output / "email - page.html").read_bytes() == b"<p>Attached HTML</p>"


def test_attached_email_is_saved_as_eml_without_leaking_its_body_or_attachments(tmp_path):
    nested = email(subject="Forwarded subject", body="PRIVATE FORWARDED BODY")
    nested.add_attachment(
        b"nested file", maintype="application", subtype="octet-stream", filename="nested.bin"
    )
    message = email(body="Outer message body")
    message.add_attachment(nested, filename="forwarded.eml")
    source = write_eml(tmp_path / "email.eml", message)
    output = tmp_path / "pdf"

    assert run(source, output, "--extract-attachments") == 0
    text = pdf_text(output / "email.pdf")
    assert "Outer message body" in text
    assert "PRIVATE FORWARDED BODY" not in text
    assert not (output / "email - nested.bin").exists()
    forwarded = BytesParser(policy=policy.default).parsebytes((output / "email - forwarded.eml").read_bytes())
    assert str(forwarded["Subject"]) == "Forwarded subject"
    assert forwarded.get_body(preferencelist=("plain",)).get_content().strip() == "PRIVATE FORWARDED BODY"
    assert next(forwarded.iter_attachments()).get_payload(decode=True) == b"nested file"


@pytest.mark.parametrize("all_to_pdf", [False, True])
def test_eml_and_msg_with_same_stem_both_convert(tmp_path, fake_msg_factory, all_to_pdf):
    source = tmp_path / "emails"
    fake_msg_factory(source / "email.msg", FakeMessage(subject="MSG subject"))
    write_eml(source / "email.eml", email(subject="EML subject"))
    output = tmp_path / "pdf"

    assert run(source, output, *(["--all-to-pdf"] if all_to_pdf else [])) == 0
    assert "MSG subject" in pdf_text(output / "email.msg.pdf")
    assert "EML subject" in pdf_text(output / "email.eml.pdf")


def test_recursive_eml_conversion_preserves_folders_and_ignores_nested_output(tmp_path):
    source = tmp_path / "emails"
    write_eml(source / "Case A" / "email.EML", email())
    output = source / "pdf"
    output.mkdir()
    (output / "previous.eml").write_bytes(b"invalid but must not be read")

    assert run(source, output, "--recursive") == 0
    assert (output / "Case A" / "email.pdf").is_file()
    assert not (output / "pdf").exists()


@pytest.mark.parametrize("overwrite", [False, True])
def test_existing_eml_pdf_is_skipped_or_replaced(tmp_path, overwrite):
    source = write_eml(tmp_path / "email.eml", email(subject="Replacement subject"))
    output = tmp_path / "pdf"
    output.mkdir()
    pdf = output / "email.pdf"
    pdf.write_bytes(b"existing PDF")

    assert run(source, output, *(["--overwrite"] if overwrite else [])) == 0
    if overwrite:
        assert "Replacement subject" in pdf_text(pdf)
    else:
        assert pdf.read_bytes() == b"existing PDF"


def test_attachments_are_extracted_even_when_eml_pdf_already_exists(tmp_path, capsys):
    message = email()
    message.add_attachment(b"notes", maintype="text", subtype="plain", filename="notes.txt")
    source = write_eml(tmp_path / "email.eml", message)
    output = tmp_path / "pdf"
    output.mkdir()
    pdf = output / "email.pdf"
    pdf.write_bytes(b"keep existing PDF")

    assert run(source, output, "--extract-attachments", "--verbose") == 0
    assert pdf.read_bytes() == b"keep existing PDF"
    assert (output / "email - notes.txt").read_bytes() == b"notes"
    assert "PDF exists; attachments processed" in capsys.readouterr().out


def test_eml_office_attachments_use_mixed_mode_conversion(tmp_path, monkeypatch):
    message = email()
    message.add_attachment(
        b"Word attachment bytes", maintype="application", subtype="octet-stream", filename="contract.docx"
    )
    message.add_attachment(b"original PDF bytes", maintype="application", subtype="pdf", filename="scan.pdf")
    source = write_eml(tmp_path / "email.eml", message)
    output = tmp_path / "pdf"
    converted = []

    def convert(source, destination, *, overwrite):
        converted.append(source.read_bytes())
        assert source.suffix == ".docx"
        destination.write_bytes(b"%PDF-1.7\nconverted Office attachment")
        return True

    monkeypatch.setattr("msg2pdf.attachments.convert_office_to_pdf", convert)
    assert run(source, output, "--all-to-pdf", "--extract-attachments") == 0
    assert converted == [b"Word attachment bytes"]
    assert (output / "email - contract.pdf").read_bytes().startswith(b"%PDF-")
    assert (output / "email - scan.pdf").read_bytes() == b"original PDF bytes"
    assert not (output / "email - contract.docx").exists()


@pytest.mark.parametrize(
    "invalid",
    [
        b"Not an email",
        b"",
        b'Subject: Broken\r\nContent-Type: multipart/mixed; boundary="missing"\r\n\r\nBroken body',
    ],
)
def test_malformed_eml_reports_failure_and_batch_continues(tmp_path, capsys, invalid):
    source = tmp_path / "emails"
    write_eml(source / "good.eml", email())
    (source / "broken.eml").write_bytes(invalid)
    output = tmp_path / "pdf"

    assert run(source, output) == 1
    assert (output / "good.pdf").is_file()
    assert not (output / "broken.pdf").exists()
    captured = capsys.readouterr()
    assert "invalid EML message" in captured.err
    assert "Failed:    1" in captured.out
