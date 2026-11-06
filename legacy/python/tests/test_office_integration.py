"""Opt-in tests that use a real, supported LibreOffice and the real sandbox."""

import os
from zipfile import ZipFile

import pytest
from pypdf import PdfReader

from msg2pdf.office import convert_office_to_pdf

pytestmark = pytest.mark.skipif(
    os.environ.get("MSG2PDF_TEST_OFFICE") != "1",
    reason="set MSG2PDF_TEST_OFFICE=1 with a supported LibreOffice installation",
)


def test_real_word_conversion(tmp_path):
    source = tmp_path / "document.docx"
    with ZipFile(source, "w") as archive:
        archive.writestr(
            "[Content_Types].xml",
            """<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>""",
        )
        archive.writestr(
            "_rels/.rels",
            """<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>""",
        )
        archive.writestr(
            "word/document.xml",
            """<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Real Office audit</w:t></w:r></w:p><w:sectPr/></w:body></w:document>""",
        )
    output = tmp_path / "output" / "document.pdf"
    assert convert_office_to_pdf(source, output)
    assert "Real Office audit" in "\n".join(p.extract_text() for p in PdfReader(output).pages)
    assert list(output.parent.iterdir()) == [output]
