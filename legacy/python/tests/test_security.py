from __future__ import annotations

import subprocess
import sys
import socket
from email.message import EmailMessage
from pathlib import Path

import pytest
from extract_msg.ole_writer import OleWriter
from pypdf import PdfReader

from msg2pdf.cli import main
from msg2pdf.converter import extract_message
from msg2pdf.filenames import NameAllocator, allocate_output_names
from msg2pdf.limits import run_bounded
from msg2pdf.models import EmailMessage as RenderMessage
from msg2pdf.office import check_libreoffice_version
from msg2pdf.paths import native_path
from msg2pdf.renderer import _make_url_fetcher, render_email_to_pdf
from msg2pdf.sandbox import office_command


def eml(path, attachment=None):
    path = native_path(path)
    message = EmailMessage()
    message["From"] = "sender@example.com"
    message["Subject"] = "Original subject"
    message.set_content("Hello")
    if attachment:
        message.add_attachment(
            attachment[1], maintype="application", subtype="octet-stream", filename=attachment[0]
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(message.as_bytes())
    return path


@pytest.mark.parametrize("single", [False, True])
def test_sources_cannot_be_overwritten_by_inplace_extraction(tmp_path, single):
    original = eml(tmp_path / "email - forwarded.eml")
    parent = eml(tmp_path / "email.eml", ("forwarded.eml", b"replacement"))
    before = original.read_bytes()
    assert (
        main(
            [
                "--input",
                str(parent if single else tmp_path),
                "--output",
                str(tmp_path),
                "--extract-attachments",
                "--overwrite",
            ]
        )
        == 2
    )
    assert original.read_bytes() == before
    assert not list(tmp_path.glob("*.pdf"))


@pytest.mark.parametrize("overwrite", [False, True])
def test_cross_email_attachment_names_are_unique_and_repeatable(tmp_path, overwrite):
    inputs, output = tmp_path / "input", tmp_path / "output"
    eml(inputs / "a.eml", ("b - c.txt", b"first"))
    eml(inputs / "a - b.eml", ("c.txt", b"second"))
    args = ["--input", str(inputs), "--output", str(output), "--extract-attachments"]
    if overwrite:
        args.append("--overwrite")
    for _ in range(2):
        assert main(args) == 0
        assert {p.read_bytes() for p in output.glob("*.txt")} == {b"first", b"second"}
        assert len(list(output.iterdir())) == 4


def test_output_subfolder_symlink_cannot_escape(tmp_path):
    source = eml(tmp_path / "input" / "Case" / "email.eml", ("notes.txt", b"private"))
    output, outside = tmp_path / "output", tmp_path / "outside"
    output.mkdir()
    outside.mkdir()
    try:
        (output / "Case").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlinks require privileges on this Windows runner")
    assert (
        main(
            [
                "--input",
                str(source.parent.parent),
                "--output",
                str(output),
                "--recursive",
                "--extract-attachments",
                "--overwrite",
            ]
        )
        == 1
    )
    assert not list(outside.iterdir())


def test_walk_errors_are_reported_and_other_files_continue(tmp_path, monkeypatch, capsys):
    source = eml(tmp_path / "input" / "visible.eml")
    original = Path.walk

    def walk(path, **kwargs):
        kwargs["on_error"](PermissionError("restricted folder"))
        yield from original(path, **kwargs)

    monkeypatch.setattr(Path, "walk", walk)
    output = tmp_path / "output"
    assert main(["--input", str(source.parent), "--output", str(output), "--recursive"]) == 1
    assert (output / "visible.pdf").is_file()
    assert "restricted folder" in capsys.readouterr().err


def test_email_styles_cannot_hide_metadata_or_escape_wrapper(tmp_path):
    pdf = tmp_path / "email.pdf"
    message = RenderMessage(
        subject="TRUSTED SUBJECT",
        sender="REAL SENDER",
        html_body="""
      </section><style>.document-header, header {display:none !important}
      @page {size:1px 1px} p {position:fixed;top:0;transform:translateY(-1000px)}</style>
      <body style="display:none"><p>BODY CONTENT</p></body><script>UNTRUSTED SCRIPT</script>""",
    )
    render_email_to_pdf(message, pdf)
    reader = PdfReader(pdf)
    text = "\n".join(p.extract_text() for p in reader.pages)
    assert "TRUSTED SUBJECT" in text and "REAL SENDER" in text
    assert "BODY CONTENT" in text
    assert "UNTRUSTED SCRIPT" not in text
    assert float(reader.pages[0].mediabox.width) > 500


@pytest.fixture
def real_msg(tmp_path):
    path = tmp_path / "cp1252.msg"
    writer = OleWriter()
    writer.addEntry("__properties_version1.0", bytes(32))
    for prop, text in [("001A", "IPM.Note"), ("0037", "Real MSG"), ("1000", "£50 – café")]:
        writer.addEntry("__substg1.0_" + prop + "001F", text.encode("utf-16-le"))
    writer.addEntry(
        "__substg1.0_10130102",
        '<html><head><meta charset="windows-1252"></head><body>£50 – café</body></html>'.encode("cp1252"),
    )
    writer.write(path)
    return path


def test_real_msg_charset_survives_extraction_and_rendering(real_msg, tmp_path):
    assert "£50 – café" in extract_message(real_msg).html_body
    output = tmp_path / "output"
    assert main(["--input", str(real_msg), "--output", str(output)]) == 0
    assert "£50 – café" in PdfReader(output / "cp1252.pdf").pages[0].extract_text()


def test_long_single_filename_converts(tmp_path):
    source = eml(tmp_path / ("x" * 246 + ".eml"))
    output = tmp_path / "output"
    assert main(["--input", str(source), "--output", str(output)]) == 0
    assert len(list(output.glob("*.pdf"))) == 1
    assert all(len(p.name.encode()) <= 240 for p in output.iterdir())


@pytest.mark.parametrize(
    "name, expected",
    [
        ("CON.eml", "_CON.pdf"),
        ("a:b.eml", "a_b.pdf"),
        ("report?.eml", "report_.pdf"),
        ("LPT¹.eml", "_LPT¹.pdf"),
    ],
)
def test_windows_names_are_portable(name, expected):
    assert allocate_output_names([name], convert_extensions={".eml"}) == [expected]


def test_allocator_resumes_suffix_search_and_skips_future_names():
    allocator = NameAllocator()
    names = allocate_output_names(["same.txt"] * 3000, convert_extensions=set(), reserved_names=allocator)
    assert len(set(names)) == 3000
    assert allocator.next_number["same.txt"] == 3001


def test_extraction_only_does_not_encode_inline_images(tmp_path, monkeypatch):
    message = EmailMessage()
    message["Subject"] = "Inline"
    message.set_content("plain")
    message.add_alternative('<img src="cid:logo">', subtype="html")
    message.get_payload()[-1].add_related(b"png", maintype="image", subtype="png", cid="<logo>")
    source = tmp_path / "email.eml"
    source.write_bytes(message.as_bytes())
    output = tmp_path / "output"
    output.mkdir()
    (output / "email.pdf").write_bytes(b"keep")
    monkeypatch.setattr("msg2pdf.converter._add_inline_image", lambda *args: pytest.fail("must not encode"))
    assert main(["--input", str(source), "--output", str(output), "--extract-attachments"]) == 0


def test_oversized_input_fails_before_parsing(tmp_path, monkeypatch):
    source = eml(tmp_path / "email.eml")
    monkeypatch.setattr("msg2pdf.limits.MAX_INPUT_BYTES", 1)
    assert main(["--input", str(source), "--output", str(tmp_path / "output")]) == 1


def test_render_timeout_preserves_old_pdf(tmp_path, monkeypatch):
    output = tmp_path / "email.pdf"
    output.write_bytes(b"keep original")

    def timeout(*args, **kwargs):
        run_bounded([sys.executable, "-c", "import time; time.sleep(10)"], timeout=0.2)

    monkeypatch.setattr("msg2pdf.renderer.run_bounded", timeout)
    with pytest.raises(RuntimeError, match="timed out"):
        render_email_to_pdf(RenderMessage(plain_body="hello"), output)
    assert output.read_bytes() == b"keep original"
    assert list(tmp_path.iterdir()) == [output]


def test_memory_watchdog_terminates_worker():
    with pytest.raises(RuntimeError, match="memory limit"):
        run_bounded(
            [sys.executable, "-c", "import time; x=bytearray(32*1024*1024); time.sleep(10)"],
            timeout=5,
            memory_bytes=16 * 1024 * 1024,
        )


@pytest.mark.parametrize("protocol", ["https://example.invalid/image.png", "file:///private/secret"])
def test_resource_fetcher_blocks_external_resources(protocol):
    fetcher = _make_url_fetcher()
    with pytest.raises(ValueError):
        fetcher.fetch(protocol)


@pytest.mark.parametrize(
    "version, allowed",
    [
        ("25.8.7", False),
        ("26.2.5", False),
        ("26.2.6", True),
        ("26.8.0", False),
        ("26.8.1", True),
        ("27.2.0", True),
    ],
)
def test_libreoffice_version_floor(monkeypatch, version, allowed):
    check_libreoffice_version.cache_clear()
    monkeypatch.setattr(
        "msg2pdf.office.subprocess.run",
        lambda *a, **k: subprocess.CompletedProcess(a, 0, f"LibreOffice {version}", ""),
    )
    if allowed:
        check_libreoffice_version("/test/soffice")
    else:
        with pytest.raises(OSError):
            check_libreoffice_version("/test/soffice")
    check_libreoffice_version.cache_clear()


def test_office_sandbox_is_required(monkeypatch, tmp_path):
    monkeypatch.setattr("msg2pdf.sandbox.shutil.which", lambda name: None)
    with pytest.raises(OSError, match="requires"):
        office_command(["/usr/bin/soffice"], tmp_path)


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS sandbox integration")
def test_macos_office_sandbox_blocks_private_reads_and_network(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    private = tmp_path / "secret.txt"
    private.write_text("private data")
    command = office_command(["/bin/cat", str(private)], workspace)
    result = subprocess.run(command, capture_output=True)
    assert result.returncode != 0
    assert b"private data" not in result.stdout
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        probe = ["/usr/bin/nc", "-z", "-G", "1", "127.0.0.1", str(listener.getsockname()[1])]
        assert subprocess.run(probe, capture_output=True, timeout=5).returncode == 0
        blocked = subprocess.run(office_command(probe, workspace), capture_output=True, timeout=5)
        assert blocked.returncode != 0
