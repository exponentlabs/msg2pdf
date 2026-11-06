from __future__ import annotations

from email.message import EmailMessage as MimeMessage
from types import SimpleNamespace

import pytest
from pypdf import PdfReader

from msg2pdf.attachments import save_attachments
from msg2pdf.cli import main
from msg2pdf.converter import extract_message
from msg2pdf.renderer import build_html_document
from tests.conftest import FakeAttachment, FakeMessage


def run(source, output, *options):
    return main(["--input", str(source), "--output", str(output), "--extract-attachments", *options])


def test_extracts_binary_unicode_empty_and_image_file_attachments(tmp_path, fake_msg_factory):
    source = tmp_path / "Café résumé.msg"
    message = FakeMessage(
        attachments=[
            FakeAttachment(longFilename="contract.pdf", data=b"\x00\xffPDF data"),
            FakeAttachment(shortFilename="résumé.txt", data=b"supporting document"),
            FakeAttachment(longFilename="empty.txt", data=b""),
            FakeAttachment(longFilename="photo.png", data=b"attached photo", cid="unused-photo-id"),
            FakeAttachment(data=b"unnamed bytes"),
        ]
    )
    fake_msg_factory(source, message)
    output = tmp_path / "pdf"

    assert run(source, output) == 0
    assert (output / "Café résumé.pdf").is_file()
    assert (output / "Café résumé - contract.pdf").read_bytes() == b"\x00\xffPDF data"
    assert (output / "Café résumé - résumé.txt").read_bytes() == b"supporting document"
    assert (output / "Café résumé - empty.txt").read_bytes() == b""
    assert (output / "Café résumé - photo.png").read_bytes() == b"attached photo"
    assert (output / "Café résumé - attachment-5").read_bytes() == b"unnamed bytes"
    assert all(path.is_file() for path in output.iterdir())
    assert message.closed


def test_inline_signature_image_stays_in_pdf_without_being_extracted(tmp_path, fake_msg_factory):
    source = tmp_path / "email.msg"
    image_data = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
        "0000000d49444154789c6360f8cf00000101000118dd8db40000000049454e44ae426082"
    )
    fake_msg_factory(
        source,
        FakeMessage(
            htmlBody='<p>Hello</p><img src="CID:Logo%40Example" alt="Signature logo">',
            attachments=[
                FakeAttachment(longFilename="logo.png", data=image_data, cid="<logo@example>"),
                FakeAttachment(longFilename="contract.txt", data=b"contract"),
            ],
        ),
    )
    output = tmp_path / "pdf"

    assert run(source, output) == 0
    assert any(page.images for page in PdfReader(output / "email.pdf").pages)
    assert not (output / "email - logo.png").exists()
    assert (output / "email - contract.txt").read_bytes() == b"contract"
    assert {path.name for path in output.iterdir()} == {"email.pdf", "email - contract.txt"}


@pytest.mark.parametrize(
    "body",
    [
        '<img src="CID:Logo%40Example">',
        '<img src="cid:&lt;Logo@Example&gt;">',
        '<img src="cid:Logo&#64;Example">',
        '<div style="background-image:url(cid:Logo@Example)">Hello</div>',
        '<style>.signature{background:url("cid:Logo@Example")}</style><p>Hello</p>',
        '<svg><image xlink:href="cid:Logo@Example" /></svg>',
        '<object data="cid:Logo@Example"></object>',
    ],
)
def test_inline_resource_matching_uses_rendered_html(tmp_path, fake_msg_factory, body):
    source = tmp_path / "email.msg"
    fake_msg_factory(
        source,
        FakeMessage(
            htmlBody=body,
            attachments=[
                FakeAttachment(longFilename="logo.png", data=b"logo", cid="<logo@example>"),
                FakeAttachment(longFilename="notes.txt", data=b"notes"),
            ],
        ),
    )
    prefix = tmp_path / "pdf" / "email"

    message = extract_message(source, attachment_prefix=prefix)
    assert not (prefix.parent / "email - logo.png").exists()
    assert (prefix.parent / "email - notes.txt").read_bytes() == b"notes"
    document = build_html_document(message)
    assert "data:image/png;base64,bG9nbw==" in document


def test_hidden_signature_resources_are_not_extracted_even_without_body_references(
    tmp_path, fake_msg_factory
):
    source = tmp_path / "email.msg"
    fake_msg_factory(
        source,
        FakeMessage(
            attachments=[
                FakeAttachment(longFilename="signature.png", data=b"signature", hidden=True),
                FakeAttachment(longFilename="unavailable-logo.png", hidden=True),
                FakeAttachment(longFilename="report.txt", data=b"report"),
            ]
        ),
    )
    output = tmp_path / "pdf"

    assert run(source, output) == 0
    assert {path.name for path in output.iterdir()} == {"email.pdf", "email - report.txt"}


def test_signed_mime_inline_resources_are_excluded(tmp_path, fake_msg_factory):
    source = tmp_path / "email.msg"
    inline_mime = MimeMessage()
    inline_mime["Content-Disposition"] = "inline"
    referenced_mime = MimeMessage()
    referenced_mime["Content-ID"] = "<signed-logo@example>"
    fake_msg_factory(
        source,
        FakeMessage(
            htmlBody='<img src="cid:signed-logo@example">',
            attachments=[
                SimpleNamespace(name="signature.png", data=b"inline", emailMessage=inline_mime),
                SimpleNamespace(name="logo.png", data=b"logo", emailMessage=referenced_mime),
                FakeAttachment(longFilename="document.txt", data=b"document"),
            ],
        ),
    )
    prefix = tmp_path / "pdf" / "email"

    message = extract_message(source, attachment_prefix=prefix)
    assert list(prefix.parent.iterdir()) == [prefix.parent / "email - document.txt"]
    assert "signed-logo@example" in message.inline_images


@pytest.mark.parametrize(
    "body",
    [
        '<a href="cid:photo@example">Download photo</a>',
        "<p>The content ID is cid:photo@example</p>",
        '<html><head><link href="cid:photo@example"></head><body>Hello</body></html>',
    ],
)
def test_attachment_links_and_text_do_not_count_as_displayed_contents(tmp_path, fake_msg_factory, body):
    source = tmp_path / "email.msg"
    fake_msg_factory(
        source,
        FakeMessage(
            htmlBody=body,
            attachments=[
                FakeAttachment(longFilename="photo.jpg", data=b"attached photo", cid="photo@example"),
            ],
        ),
    )
    prefix = tmp_path / "pdf" / "email"

    extract_message(source, attachment_prefix=prefix)
    assert (prefix.parent / "email - photo.jpg").read_bytes() == b"attached photo"


def test_skips_inline_images_when_pdf_already_exists(tmp_path, fake_msg_factory):
    source = tmp_path / "email.msg"
    fake_msg_factory(
        source,
        FakeMessage(
            htmlBody='<img src="cid:logo">',
            attachments=[
                FakeAttachment(longFilename="logo.png", data=b"signature", cid="logo"),
                FakeAttachment(longFilename="notes.txt", data=b"notes"),
            ],
        ),
    )
    output = tmp_path / "pdf"
    output.mkdir()
    pdf = output / "email.pdf"
    pdf.write_bytes(b"existing PDF")

    assert run(source, output) == 0
    assert pdf.read_bytes() == b"existing PDF"
    assert not (output / "email - logo.png").exists()
    assert (output / "email - notes.txt").read_bytes() == b"notes"


def test_extraction_can_be_enabled_after_pdf_was_created(tmp_path, fake_msg_factory, capsys):
    source = tmp_path / "email.msg"
    fake_msg_factory(
        source, FakeMessage(attachments=[FakeAttachment(longFilename="contract.txt", data=b"contract")])
    )
    output = tmp_path / "pdf"
    output.mkdir()
    pdf = output / "email.pdf"
    pdf.write_bytes(b"keep existing PDF")

    assert run(source, output, "--verbose") == 0
    assert pdf.read_bytes() == b"keep existing PDF"
    assert (output / "email - contract.txt").read_bytes() == b"contract"
    assert "PDF exists; attachments processed" in capsys.readouterr().out


@pytest.mark.parametrize("overwrite", [False, True])
def test_rerun_preserves_or_replaces_existing_attachments(tmp_path, fake_msg_factory, overwrite):
    source = tmp_path / "email.msg"
    fake_msg_factory(
        source,
        FakeMessage(
            attachments=[
                FakeAttachment(longFilename="report.txt", data=b"new first"),
                FakeAttachment(longFilename="report.txt", data=b"new second"),
            ]
        ),
    )
    output = tmp_path / "pdf"
    output.mkdir()
    pdf = output / "email.pdf"
    pdf.write_bytes(b"old PDF")
    first = output / "email - report.txt"
    second = output / "email - report (2).txt"
    first.write_bytes(b"old first")
    second.write_bytes(b"old second")

    options = ["--overwrite"] if overwrite else []
    assert run(source, output, *options) == 0
    assert first.read_bytes() == (b"new first" if overwrite else b"old first")
    assert second.read_bytes() == (b"new second" if overwrite else b"old second")
    assert (pdf.read_bytes() != b"old PDF") == overwrite
    assert {path.name for path in output.iterdir()} == {
        "email.pdf",
        "email - report.txt",
        "email - report (2).txt",
    }


def test_names_are_safe_unique_and_repeatable(tmp_path):
    names = [
        "../../contract.txt",
        r"C:\private\contract.txt",
        "CONTRACT.TXT",
        "contract (2).txt",
        "\x00bad?.txt",
        "/",
        "..",
        "(unnamed attachment)",
        "café.txt",
        "cafe\u0301.txt",
        "深" * 100 + ".txt",
        "深" * 100 + ".txt",
    ]
    attachments = [FakeAttachment(data=str(index).encode()) for index in range(len(names))]
    prefix = tmp_path / "pdf" / "email"

    save_attachments(attachments, names, prefix, overwrite=False)
    files = sorted(prefix.parent.iterdir())
    assert len(files) == len(names)
    assert {path.read_bytes() for path in files} == {str(index).encode() for index in range(len(names))}
    assert (prefix.parent / "email - contract.txt").read_bytes() == b"0"
    assert (prefix.parent / "email - contract (2).txt").read_bytes() == b"1"
    assert (prefix.parent / "email - CONTRACT (3).TXT").read_bytes() == b"2"
    assert (prefix.parent / "email - contract (2) (2).txt").read_bytes() == b"3"
    assert (prefix.parent / "email - _bad_.txt").read_bytes() == b"4"
    assert (prefix.parent / "email - attachment-8").read_bytes() == b"7"
    assert all(path.parent == prefix.parent and len(path.name.encode()) <= 240 for path in files)
    assert not (tmp_path / "contract.txt").exists()

    save_attachments(attachments, names, prefix, overwrite=False)
    assert sorted(prefix.parent.iterdir()) == files


def test_attached_message_is_exported_before_parent_closes(tmp_path, fake_msg_factory):
    source = tmp_path / "email.msg"
    message = FakeMessage()

    def export(stream):
        assert not message.closed
        stream.write(b"exported embedded MSG")

    message.attachments = [
        SimpleNamespace(name="forwarded.msg", displayName="forwarded", data=SimpleNamespace(export=export))
    ]
    fake_msg_factory(source, message)
    output = tmp_path / "pdf"

    assert run(source, output) == 0
    assert (output / "email - forwarded.msg").read_bytes() == b"exported embedded MSG"
    assert message.closed


def test_failed_export_preserves_existing_file_and_removes_temp_file(tmp_path, fake_msg_factory):
    source = tmp_path / "email.msg"

    def export(stream):
        stream.write(b"partial data")
        raise ValueError("broken embedded MSG")

    message = FakeMessage(
        attachments=[SimpleNamespace(longFilename="forwarded.msg", data=SimpleNamespace(export=export))]
    )
    fake_msg_factory(source, message)
    output = tmp_path / "pdf"
    output.mkdir()
    attachment = output / "email - forwarded.msg"
    attachment.write_bytes(b"existing attachment")

    assert run(source, output, "--overwrite") == 1
    assert attachment.read_bytes() == b"existing attachment"
    assert list(output.iterdir()) == [attachment]
    assert message.closed


def test_missing_attachment_data_is_reported_and_batch_continues(tmp_path, fake_msg_factory, capsys):
    source = tmp_path / "emails"
    broken = FakeMessage(attachments=[FakeAttachment(longFilename="missing.txt")])
    fake_msg_factory(source / "broken.msg", broken)
    fake_msg_factory(
        source / "good.msg",
        FakeMessage(attachments=[FakeAttachment(longFilename="report.txt", data=b"available")]),
    )
    output = tmp_path / "pdf"

    assert run(source, output) == 1
    assert "attachment data is unavailable or unsupported" in capsys.readouterr().err
    assert not (output / "broken.pdf").exists()
    assert (output / "good.pdf").is_file()
    assert (output / "good - report.txt").read_bytes() == b"available"
    assert broken.closed


@pytest.mark.parametrize("overwrite", [False, True])
@pytest.mark.parametrize("obstruction", ["directory", "symlink"])
def test_refuses_attachment_output_directories_and_symlinks(tmp_path, obstruction, overwrite):
    output = tmp_path / "pdf"
    output.mkdir()
    destination = output / "email - report.txt"
    target = tmp_path / "original.txt"
    target.write_bytes(b"keep this file")
    if obstruction == "directory":
        destination.mkdir()
    else:
        destination.symlink_to(target)

    with pytest.raises(OSError, match="attachment output path"):
        save_attachments(
            [FakeAttachment(data=b"replacement")],
            ["report.txt"],
            output / "email",
            overwrite=overwrite,
        )
    assert target.read_bytes() == b"keep this file"


def test_no_attachments_creates_only_pdf(tmp_path, fake_msg_factory):
    source = tmp_path / "email.msg"
    fake_msg_factory(source, FakeMessage())
    output = tmp_path / "pdf"

    assert run(source, output) == 0
    assert list(output.iterdir()) == [output / "email.pdf"]


def test_recursive_extraction_preserves_relative_folders_and_ignores_output(
    tmp_path, fake_msg_factory, capsys
):
    source = tmp_path / "emails"
    first = source / "Case A" / "email.msg"
    second = source / "Case B" / "email.msg"
    for path in (first, second):
        fake_msg_factory(
            path,
            FakeMessage(attachments=[FakeAttachment(longFilename="forwarded.msg", data=b"attached MSG")]),
        )
    output = source / "pdf"
    # An existing output .msg must not become an input either.
    output.mkdir()
    (output / "previous - forwarded.msg").write_bytes(b"old attachment")

    assert run(source, output, "--recursive") == 0
    for folder in ("Case A", "Case B"):
        assert (output / folder / "email.pdf").is_file()
        assert (output / folder / "email - forwarded.msg").read_bytes() == b"attached MSG"
    assert "Processed: 2" in capsys.readouterr().out


def test_same_input_output_is_rejected_before_extraction(tmp_path, fake_msg_factory, capsys):
    source = tmp_path / "email.msg"
    fake_msg_factory(
        source, FakeMessage(attachments=[FakeAttachment(longFilename="forwarded.msg", data=b"attached MSG")])
    )

    assert run(tmp_path, tmp_path, "--recursive") == 2
    assert list(tmp_path.iterdir()) == [source]
    assert "separate output directory" in capsys.readouterr().err
