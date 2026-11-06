from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from msg2pdf.cli import main
from msg2pdf.office import convert_office_to_pdf, copy_pdf
from msg2pdf.paths import native_path
from tests.conftest import FakeAttachment, FakeMessage


@pytest.fixture
def fake_office(monkeypatch):
    calls = []
    monkeypatch.setattr("msg2pdf.office.find_libreoffice", lambda: "/fake/soffice")
    monkeypatch.setattr("msg2pdf.office.check_libreoffice_version", lambda command: None)
    monkeypatch.setattr("msg2pdf.office.office_command", lambda command, workspace: command)

    def run(command, **kwargs):
        source = Path(command[-1])
        calls.append((source.suffix.lower(), source.read_bytes()))
        assert source.is_absolute()
        assert "--headless" in command
        assert any(value.startswith("-env:UserInstallation=file:") for value in command)
        assert kwargs["timeout"] == 120
        assert "shell" not in kwargs
        directory = Path(command[command.index("--outdir") + 1])
        (directory / source.with_suffix(".pdf").name).write_bytes(b"%PDF-1.7\n" + source.read_bytes())
        return subprocess.CompletedProcess(command, 0, "converted", "")

    monkeypatch.setattr("msg2pdf.office.run_bounded", run)
    return calls


def run(source, output, *options):
    return main(["--input", str(source), "--output", str(output), "--all-to-pdf", *options])


def write(path, data=b"source document"):
    path = native_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def test_mixed_folder_converts_office_and_emails_and_copies_pdf(
    tmp_path, fake_msg_factory, fake_office, capsys
):
    source = tmp_path / "export"
    fake_msg_factory(source / "email.msg", FakeMessage())
    for extension in ("docx", "xlsx", "pptx"):
        write(source / f"document.{extension}", extension.encode())
    write(source / "existing.PDF", b"original PDF bytes")
    write(source / "archive.zip")
    write(source / "~$locked.docx")
    output = tmp_path / "pdf"

    assert run(source, output, "--verbose") == 0
    assert (output / "email.pdf").is_file()
    assert (output / "existing.PDF").read_bytes() == b"original PDF bytes"
    for extension in ("docx", "xlsx", "pptx"):
        assert (output / f"document.{extension}.pdf").read_bytes().endswith(extension.encode())
        assert (source / f"document.{extension}").read_bytes() == extension.encode()
    assert len(fake_office) == 3
    captured = capsys.readouterr()
    assert "Converted: 4" in captured.out
    assert "Copied:    1" in captured.out
    assert "Unsupported: 2" in captured.out
    assert "Failed:    0" in captured.out


def test_default_mode_still_processes_only_emails(tmp_path, fake_msg_factory, monkeypatch):
    source = tmp_path / "export"
    fake_msg_factory(source / "email.msg", FakeMessage())
    write(source / "document.docx")
    write(source / "existing.pdf")
    monkeypatch.setattr("msg2pdf.office.find_libreoffice", lambda: pytest.fail("Office must not run"))
    output = tmp_path / "pdf"

    assert main(["--input", str(source), "--output", str(output)]) == 0
    assert list(output.iterdir()) == [output / "email.pdf"]


def test_recursive_mixed_conversion_excludes_nested_output(tmp_path, fake_office, capsys):
    source = tmp_path / "export"
    write(source / "Case A" / "report.docx")
    write(source / "Case B" / "scan.pdf", b"scan")
    output = source / "pdf"
    write(output / "previous.pdf", b"old output")

    assert run(source, output, "--recursive") == 0
    assert (output / "Case A" / "report.pdf").is_file()
    assert (output / "Case B" / "scan.pdf").read_bytes() == b"scan"
    assert not (output / "pdf").exists()
    assert "Processed: 2" in capsys.readouterr().out


@pytest.mark.parametrize(
    "extension", [".DOC", ".DOCX", ".XLS", ".XLSX", ".PPT", ".PPTX", ".xlsb", ".docm", ".pptm"]
)
def test_single_office_file_conversion(tmp_path, fake_office, extension):
    source = write(tmp_path / f"Résumé{extension}")
    output = tmp_path / "pdf"

    assert run(source, output) == 0
    assert (output / "Résumé.pdf").read_bytes() == b"%PDF-1.7\nsource document"


def test_nonrecursive_mixed_input_does_not_convert_nested_documents(tmp_path, fake_office):
    source = tmp_path / "export"
    write(source / "top.docx")
    write(source / "nested" / "other.docx")
    output = tmp_path / "pdf"

    assert run(source, output) == 0
    assert (output / "top.pdf").is_file()
    assert not (output / "nested").exists()
    assert len(fake_office) == 1


@pytest.mark.parametrize("overwrite", [False, True])
def test_pdf_copy_preserves_or_replaces_destination(tmp_path, overwrite, monkeypatch):
    source = write(tmp_path / "source" / "scan.pdf", b"source PDF")
    output = tmp_path / "pdf"
    destination = write(output / "scan.pdf", b"old PDF")
    monkeypatch.setattr("msg2pdf.office.find_libreoffice", lambda: pytest.fail("PDF copying needs no Office"))

    assert run(source, output, *(["--overwrite"] if overwrite else [])) == 0
    assert destination.read_bytes() == (b"source PDF" if overwrite else b"old PDF")
    assert source.read_bytes() == b"source PDF"


def test_same_file_pdf_copy_is_a_noop_even_with_overwrite(tmp_path):
    source = write(tmp_path / "scan.pdf", b"keep original")
    assert not copy_pdf(source, source, overwrite=True)
    assert source.read_bytes() == b"keep original"


def test_pdf_copy_keeps_a_long_original_filename(tmp_path):
    source = write(tmp_path / "export" / ("a" * 245 + ".pdf"), b"original PDF")
    output = tmp_path / "pdf"

    assert run(source.parent, output) == 0
    assert (output / source.name).read_bytes() == b"original PDF"


def test_same_stem_and_case_collisions_preserve_every_input(tmp_path, fake_office, fake_msg_factory):
    source = tmp_path / "export"
    write(source / "Report.pdf", b"original PDF")
    write(source / "report.docx", b"Word")
    write(source / "report.xlsx", b"Excel")
    write(source / "report.docx.pdf", b"another original PDF")
    fake_msg_factory(source / "report.msg", FakeMessage())
    output = tmp_path / "pdf"

    assert run(source, output, "--overwrite") == 0
    assert (output / "Report.pdf").read_bytes() == b"original PDF"
    assert (output / "report.docx.pdf").read_bytes() == b"another original PDF"
    assert (output / "report.docx (2).pdf").read_bytes() == b"%PDF-1.7\nWord"
    assert (output / "report.xlsx.pdf").read_bytes() == b"%PDF-1.7\nExcel"
    assert (output / "report.msg.pdf").is_file()
    assert len(list(output.iterdir())) == 5
    assert run(source, output) == 0
    assert len(list(output.iterdir())) == 5
    assert len(fake_office) == 2


def test_office_attachments_are_converted_and_existing_pdf_attachments_preserved(
    tmp_path, fake_msg_factory, fake_office
):
    source = tmp_path / "email.msg"
    fake_msg_factory(
        source,
        FakeMessage(
            attachments=[
                FakeAttachment(longFilename="report.docx", data=b"Word attachment"),
                FakeAttachment(longFilename="report.xlsx", data=b"Excel attachment"),
                FakeAttachment(longFilename="report.pdf", data=b"original PDF attachment"),
                FakeAttachment(longFilename="signature.png", data=b"logo", hidden=True),
            ]
        ),
    )
    output = tmp_path / "pdf"

    assert run(source, output, "--extract-attachments") == 0
    assert (output / "email - report.docx.pdf").read_bytes() == b"%PDF-1.7\nWord attachment"
    assert (output / "email - report.xlsx.pdf").read_bytes() == b"%PDF-1.7\nExcel attachment"
    assert (output / "email - report.pdf").read_bytes() == b"original PDF attachment"
    assert {path.suffix for path in output.iterdir()} == {".pdf"}
    assert len(fake_office) == 2
    assert len(list(output.iterdir())) == 4


def test_office_attachments_remain_original_format_without_new_flag(tmp_path, fake_msg_factory):
    source = tmp_path / "email.msg"
    fake_msg_factory(
        source, FakeMessage(attachments=[FakeAttachment(longFilename="report.docx", data=b"Word")])
    )
    output = tmp_path / "pdf"

    assert main(["--input", str(source), "--output", str(output), "--extract-attachments"]) == 0
    assert (output / "email - report.docx").read_bytes() == b"Word"


def test_office_attachment_extraction_works_when_email_pdf_already_exists(
    tmp_path, fake_msg_factory, fake_office
):
    source = tmp_path / "email.msg"
    fake_msg_factory(
        source, FakeMessage(attachments=[FakeAttachment(longFilename="report.docx", data=b"Word")])
    )
    output = tmp_path / "pdf"
    pdf = write(output / "email.pdf", b"keep PDF")

    assert run(source, output, "--extract-attachments") == 0
    assert pdf.read_bytes() == b"keep PDF"
    assert (output / "email - report.pdf").read_bytes() == b"%PDF-1.7\nWord"
    assert run(source, output, "--extract-attachments") == 0
    assert len(fake_office) == 1


def test_extracted_attachments_cannot_replace_planned_top_level_pdfs(tmp_path, fake_msg_factory):
    source = tmp_path / "export"
    fake_msg_factory(
        source / "email.msg",
        FakeMessage(attachments=[FakeAttachment(longFilename="contract.pdf", data=b"attached PDF")]),
    )
    write(source / "email - contract.pdf", b"exported PDF")
    output = tmp_path / "pdf"

    assert run(source, output, "--extract-attachments", "--overwrite") == 0
    assert (output / "email - contract.pdf").read_bytes() == b"exported PDF"
    assert (output / "email - contract (2).pdf").read_bytes() == b"attached PDF"


def test_missing_libreoffice_is_reported_but_pdf_copying_continues(tmp_path, monkeypatch, capsys):
    source = tmp_path / "export"
    write(source / "document.docx")
    write(source / "scan.pdf", b"original PDF")
    monkeypatch.setenv("MSG2PDF_SOFFICE", "/definitely/missing/soffice")
    output = tmp_path / "pdf"

    assert run(source, output) == 1
    assert (output / "scan.pdf").read_bytes() == b"original PDF"
    assert not (output / "document.pdf").exists()
    captured = capsys.readouterr()
    assert "MSG2PDF_SOFFICE is not an executable" in captured.err
    assert "Copied:    1" in captured.out
    assert "Failed:    1" in captured.out


@pytest.mark.parametrize("failure", ["nonzero", "no-output", "invalid-pdf", "timeout"])
def test_office_failure_preserves_existing_pdf_and_cleans_temporary_files(tmp_path, monkeypatch, failure):
    source = write(tmp_path / "document.docx")
    output = tmp_path / "pdf"
    destination = write(output / "document.pdf", b"keep previous PDF")
    monkeypatch.setattr("msg2pdf.office.find_libreoffice", lambda: "/fake/soffice")
    monkeypatch.setattr("msg2pdf.office.check_libreoffice_version", lambda command: None)
    monkeypatch.setattr("msg2pdf.office.office_command", lambda command, workspace: command)

    def fail(command, **kwargs):
        if failure == "timeout":
            raise subprocess.TimeoutExpired(command, 120)
        if failure == "nonzero":
            raise RuntimeError("conversion failed")
        directory = Path(command[command.index("--outdir") + 1])
        if failure == "invalid-pdf":
            (directory / "document.pdf").write_bytes(b"not PDF")
        return subprocess.CompletedProcess(command, 1 if failure == "nonzero" else 0, "", "conversion failed")

    monkeypatch.setattr("msg2pdf.office.run_bounded", fail)
    with pytest.raises(RuntimeError):
        convert_office_to_pdf(source, destination, overwrite=True)
    assert destination.read_bytes() == b"keep previous PDF"
    assert list(output.iterdir()) == [destination]


def test_mixed_mode_requires_separate_directory(tmp_path, capsys):
    source = write(tmp_path / "document.docx")
    assert run(tmp_path, tmp_path) == 2
    assert "separate output directory" in capsys.readouterr().err
    assert list(tmp_path.iterdir()) == [source]


def test_unsupported_single_file_is_rejected(tmp_path, capsys):
    source = write(tmp_path / "archive.zip")
    assert run(source, tmp_path / "pdf") == 2
    assert "unsupported input file type" in capsys.readouterr().err
