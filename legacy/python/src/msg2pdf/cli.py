from __future__ import annotations

import argparse
import sys
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .converter import convert_file
from .filenames import NameAllocator, allocate_output_names
from .paths import native_path, validate_destination
from .formats import EMAIL_EXTENSIONS, PDF_SOURCE_EXTENSIONS


@dataclass(frozen=True, slots=True)
class SourceFile:
    path: Path
    pdf_name: str | None
    reserved_names: Iterable[str] = ()
    relative_parent: Path = Path(".")


@dataclass(slots=True)
class Summary:
    processed: int = 0
    converted: int = 0
    copied: int = 0
    skipped: int = 0
    unsupported: int = 0
    failed: int = 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="msg2pdf",
        description="Convert MSG and EML emails, or mixed folders of emails, Office files and PDFs.",
    )
    parser.add_argument("--input", required=True, type=Path, help="An input file or directory.")
    parser.add_argument("--output", required=True, type=Path, help="Output directory for PDF files.")
    parser.add_argument(
        "--recursive",
        action="store_true",
        help="Search input directories recursively and preserve relative folders.",
    )
    parser.add_argument(
        "--all-to-pdf",
        action="store_true",
        help="Also convert Office files and extracted Office attachments, and copy existing PDFs.",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace PDFs and extracted attachments that already exist.",
    )
    parser.add_argument(
        "--extract-attachments",
        action="store_true",
        help="Save file attachments beside each PDF, excluding inline and hidden resources.",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="Print each file as it is processed.",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    discovery_errors: list[OSError] = []

    try:
        input_path = native_path(args.input.expanduser())
        output_path = native_path(args.output.expanduser().resolve())
        source_files = _discover_source_files(
            input_path,
            recursive=args.recursive,
            output_path=output_path,
            all_to_pdf=args.all_to_pdf,
            errors=discovery_errors,
        )
        _prepare_output_directory(output_path)
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    summary = Summary()
    for source in source_files:
        source_path = source.path
        summary.processed += 1
        if source.pdf_name is None:
            summary.unsupported += 1
            if args.verbose:
                print(f"Unsupported: {_display_path(source_path, input_path)}")
            continue
        destination = output_path / source.relative_parent / source.pdf_name
        try:
            validate_destination(destination, output_path)
            converted = convert_file(
                source_path,
                destination,
                overwrite=args.overwrite,
                extract_attachments=args.extract_attachments,
                all_to_pdf=args.all_to_pdf,
                reserved_names=source.reserved_names,
            )
        except Exception as exc:
            summary.failed += 1
            print(f"ERROR: {_display_path(source_path, input_path)} - {exc}", file=sys.stderr)
            continue

        if converted:
            copied = args.all_to_pdf and source_path.suffix.lower() == ".pdf"
            if copied:
                summary.copied += 1
            else:
                summary.converted += 1
            if args.verbose:
                action = "Copied" if copied else "Converted"
                print(f"{action}: {_display_path(source_path, input_path)} -> {destination.name}")
        else:
            summary.skipped += 1
            if args.verbose:
                detail = (
                    " (PDF exists; attachments processed)"
                    if args.extract_attachments and source_path.suffix.lower() in EMAIL_EXTENSIONS
                    else ""
                )
                print(f"Skipped:   {_display_path(source_path, input_path)}{detail}")

    for error in discovery_errors:
        summary.failed += 1
        print(f"ERROR: input discovery failed: {error}", file=sys.stderr)
    print_summary(summary, all_to_pdf=args.all_to_pdf)
    return 1 if summary.failed else 0


def print_summary(summary: Summary, *, all_to_pdf: bool = False) -> None:
    print(f"Processed: {summary.processed}")
    print(f"Converted: {summary.converted}")
    if all_to_pdf:
        print(f"Copied:    {summary.copied}")
    print(f"Skipped:   {summary.skipped}")
    if all_to_pdf:
        print(f"Unsupported: {summary.unsupported}")
    print(f"Failed:    {summary.failed}")


def _discover_source_files(
    input_path: Path,
    *,
    recursive: bool,
    output_path: Path,
    all_to_pdf: bool = False,
    errors: list[OSError] | None = None,
) -> Iterable[SourceFile]:
    if not input_path.exists():
        raise ValueError(f"input path does not exist: {input_path}")
    if input_path.resolve().is_relative_to(output_path.resolve()):
        raise ValueError("requires a separate output directory outside the input's parent hierarchy")
    if input_path.is_file():
        supported = PDF_SOURCE_EXTENSIONS if all_to_pdf else EMAIL_EXTENSIONS
        if input_path.suffix.lower() not in supported or input_path.name.startswith("~$"):
            raise ValueError(f"unsupported input file type: {input_path}")
        name = allocate_output_names(
            [input_path.name], convert_extensions=supported - {".pdf"}, preserve_unconverted=True
        )[0]
        return (SourceFile(input_path, name, NameAllocator([name])),)
    if not input_path.is_dir():
        raise ValueError(f"input path is not a file or directory: {input_path}")

    return _iter_source_files(
        input_path, output_path, recursive=recursive, all_to_pdf=all_to_pdf, errors=errors
    )


def _iter_source_files(
    input_path: Path,
    output_path: Path,
    *,
    recursive: bool,
    all_to_pdf: bool,
    errors: list[OSError] | None = None,
) -> Iterable[SourceFile]:
    # Snapshot one directory at a time so newly extracted email attachments do
    # not become inputs. Prune a nested output directory for the same reason.
    output_root = output_path.resolve()
    supported = PDF_SOURCE_EXTENSIONS if all_to_pdf else EMAIL_EXTENSIONS

    def on_error(error: OSError) -> None:
        if errors is None:
            raise error
        errors.append(error)

    output_directories = {input_path: Path(".")}
    for directory, subdirectories, filenames in input_path.walk(on_error=on_error):
        if recursive:
            subdirectories[:] = [
                name for name in subdirectories if (directory / name).resolve() != output_root
            ]
        else:
            subdirectories.clear()
        subdirectories.sort()
        directory_names = allocate_output_names(subdirectories, convert_extensions=set())
        for original, portable in zip(subdirectories, directory_names, strict=True):
            output_directories[directory / original] = output_directories[directory] / portable
        paths = []
        for name in sorted(filenames):
            path = directory / name
            try:
                if stat.S_ISREG(path.stat().st_mode):
                    paths.append(path)
            except OSError as error:
                on_error(error)
        supported_paths = [
            path for path in paths if path.suffix.lower() in supported and not path.name.startswith("~$")
        ]
        output_names = allocate_output_names(
            [path.name for path in supported_paths],
            convert_extensions=supported - {".pdf"},
            preserve_unconverted=True,
        )
        planned = dict(zip(supported_paths, output_names, strict=True))
        reserved = NameAllocator(output_names)
        for path in paths:
            if path in planned or all_to_pdf:
                yield SourceFile(path, planned.get(path), reserved, output_directories[directory])


def _prepare_output_directory(output_path: Path) -> None:
    if output_path.exists() and not output_path.is_dir():
        raise ValueError(f"output path is not a directory: {output_path}")
    output_path.mkdir(parents=True, exist_ok=True)


def _display_path(source_path: Path, input_path: Path) -> str:
    if input_path.is_dir():
        try:
            return str(source_path.relative_to(input_path))
        except ValueError:
            pass
    return str(source_path)


if __name__ == "__main__":
    raise SystemExit(main())
