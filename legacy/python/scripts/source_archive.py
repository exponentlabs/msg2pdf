"""Create a reproducible source-only review archive from an explicit allowlist."""

from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[1]
FILES = (
    "README.md",
    "pyproject.toml",
    "uv.lock",
    ".gitignore",
    ".gitattributes",
    "MANIFEST.in",
    "THIRD_PARTY_NOTICES.txt",
)
TREES = ("src/msg2pdf", "tests", "scripts", ".github/workflows")


def create_archive(destination: Path) -> Path:
    files = [ROOT / name for name in FILES if (ROOT / name).is_file()]
    for tree in TREES:
        files.extend(
            p
            for p in (ROOT / tree).rglob("*")
            if p.is_file()
            and not p.is_symlink()
            and "__pycache__" not in p.parts
            and p.suffix in {".py", ".yml", ".yaml"}
        )
    destination.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(destination, "w", compression=ZIP_DEFLATED) as archive:
        for path in sorted(files):
            info = ZipInfo("msg2pdf/" + path.relative_to(ROOT).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes())
    return destination


if __name__ == "__main__":
    print(create_archive(ROOT / "dist" / "msg2pdf-source-review.zip"))
