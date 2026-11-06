from __future__ import annotations

from pathlib import Path

from pypdf import PdfReader

from msg2pdf.cli import main
from tests.conftest import FakeAttachment, FakeMessage


def pdf_text(path: Path) -> str:
    return "\n".join(page.extract_text() or "" for page in PdfReader(path).pages)


def test_single_msg_conversion_and_unicode_filename(tmp_path, fake_msg_factory):
    source = tmp_path / "Café résumé.msg"
    fake_msg_factory(source, FakeMessage(subject="A subject with spaces"))

    output = tmp_path / "pdf"
    assert main(["--input", str(source), "--output", str(output)]) == 0

    pdf = output / "Café résumé.pdf"
    assert pdf.exists()
    text = pdf_text(pdf)
    assert "sender@example.com" in text
    assert "recipient@example.com" in text
    assert "A subject with spaces" in text
    assert "Hello from MSG" in text


def test_directory_conversion_only_processes_immediate_files_by_default(tmp_path, fake_msg_factory):
    source_dir = tmp_path / "emails"
    top_level = source_dir / "Email 1.msg"
    nested = source_dir / "Case A" / "Email 2.msg"
    fake_msg_factory(top_level, FakeMessage(subject="Top level"))
    fake_msg_factory(nested, FakeMessage(subject="Nested"))

    output = tmp_path / "pdf"
    assert main(["--input", str(source_dir), "--output", str(output)]) == 0

    assert (output / "Email 1.pdf").exists()
    assert not (output / "Case A" / "Email 2.pdf").exists()


def test_recursive_conversion_preserves_folder_structure(tmp_path, fake_msg_factory):
    source_dir = tmp_path / "emails"
    first = source_dir / "Case A" / "Email 1.msg"
    second = source_dir / "Case B" / "深い" / "Email 2.msg"
    fake_msg_factory(first, FakeMessage(subject="First"))
    fake_msg_factory(second, FakeMessage(subject="Second"))

    output = tmp_path / "pdf"
    assert main(["--input", str(source_dir), "--output", str(output), "--recursive"]) == 0

    assert (output / "Case A" / "Email 1.pdf").exists()
    assert (output / "Case B" / "深い" / "Email 2.pdf").exists()


def test_existing_file_is_skipped_without_parsing(tmp_path, fake_msg_factory):
    source = tmp_path / "already.msg"
    fake_msg_factory(source, RuntimeError("parser should not run for skipped files"))
    output = tmp_path / "pdf"
    output.mkdir()
    destination = output / "already.pdf"
    destination.write_bytes(b"keep this file")

    assert main(["--input", str(source), "--output", str(output)]) == 0
    assert destination.read_bytes() == b"keep this file"


def test_overwrite_replaces_existing_file(tmp_path, fake_msg_factory):
    source = tmp_path / "replace.msg"
    fake_msg_factory(source, FakeMessage(subject="Replacement"))
    output = tmp_path / "pdf"
    output.mkdir()
    destination = output / "replace.pdf"
    destination.write_bytes(b"old file")

    assert main(["--input", str(source), "--output", str(output), "--overwrite"]) == 0
    assert destination.read_bytes() != b"old file"
    assert "Replacement" in pdf_text(destination)


def test_plain_text_body_fallback(tmp_path, fake_msg_factory):
    source = tmp_path / "plain.msg"
    fake_msg_factory(source, FakeMessage(htmlBody="", body="line one\nline two"))

    output = tmp_path / "pdf"
    assert main(["--input", str(source), "--output", str(output)]) == 0
    text = pdf_text(output / "plain.pdf")
    assert "line one" in text
    assert "line two" in text


def test_attachment_filenames_are_listed(tmp_path, fake_msg_factory):
    source = tmp_path / "attachments.msg"
    message = FakeMessage(
        attachments=[
            FakeAttachment(longFilename="contract final.pdf"),
            FakeAttachment(longFilename="résumé – supporting file.txt"),
        ]
    )
    fake_msg_factory(source, message)

    output = tmp_path / "pdf"
    assert main(["--input", str(source), "--output", str(output)]) == 0
    text = pdf_text(output / "attachments.pdf")
    assert "contract final.pdf" in text
    assert "résumé" in text
    assert list(output.iterdir()) == [output / "attachments.pdf"]


def test_inline_cid_image_is_embedded_when_data_is_available(tmp_path, fake_msg_factory):
    source = tmp_path / "inline.msg"
    image_data = bytes.fromhex(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
        "0000000d49444154789c6360f8cf00000101000118dd8db40000000049454e44ae426082"
    )
    message = FakeMessage(
        htmlBody='<p>Image:</p><img src="cid:logo@example" alt="logo">',
        attachments=[
            FakeAttachment(
                longFilename="logo.png",
                data=image_data,
                cid="<logo@example>",
                mimetype="image/png",
            )
        ],
    )
    fake_msg_factory(source, message)

    output = tmp_path / "pdf"
    assert main(["--input", str(source), "--output", str(output)]) == 0
    reader = PdfReader(output / "inline.pdf")
    assert any(page.images for page in reader.pages)


def test_malformed_file_does_not_stop_batch_and_sets_exit_code(tmp_path, fake_msg_factory, capsys):
    source_dir = tmp_path / "emails"
    broken = source_dir / "Case A" / "broken.msg"
    good = source_dir / "Case B" / "good.msg"
    fake_msg_factory(broken, ValueError("malformed MSG"))
    fake_msg_factory(good, FakeMessage(subject="Good message"))

    output = tmp_path / "pdf"
    assert main(["--input", str(source_dir), "--output", str(output), "--recursive"]) == 1

    assert not (output / "Case A" / "broken.pdf").exists()
    assert (output / "Case B" / "good.pdf").exists()
    captured = capsys.readouterr()
    assert "ERROR: Case A/broken.msg - malformed MSG" in captured.err
    assert "Processed: 2" in captured.out
    assert "Converted: 1" in captured.out
    assert "Failed:    1" in captured.out


def test_invalid_input_returns_two(tmp_path, capsys):
    output = tmp_path / "pdf"
    assert main(["--input", str(tmp_path / "missing"), "--output", str(output)]) == 2
    assert "input path does not exist" in capsys.readouterr().err
