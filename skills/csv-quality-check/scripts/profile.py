#!/usr/bin/env python3
"""Read-only, bounded UTF-8 CSV profile. No third-party dependencies."""

import argparse
import csv
import io
import json
from pathlib import Path
import sys

MAX_BYTES = 10 * 1024 * 1024
MAX_RECORD_SAMPLES = 100


def profile(path, delimiter):
    with Path(path).open("rb") as source:
        data = source.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("Input exceeds the 10 MiB limit; use a bounded sample.")
    reader = csv.reader(io.StringIO(data.decode("utf-8-sig"), newline=""),
                        delimiter=delimiter, strict=True)
    header = next(reader, None)
    if not header:
        raise ValueError("Input must contain a nonempty header record.")
    names = [name.strip() for name in header]
    widths = []
    width_count = 0
    blanks = [0] * len(header)
    formulas = 0
    duplicate_rows = 0
    seen = set()
    count = 0
    for count, row in enumerate(reader, 1):
        if len(row) != len(header):
            width_count += 1
            if len(widths) < MAX_RECORD_SAMPLES:
                widths.append(count)
        for index, value in enumerate(row):
            if index < len(blanks) and not value.strip():
                blanks[index] += 1
            if value.lstrip().startswith(("=", "+", "-", "@")):
                formulas += 1
        key = tuple(row)
        duplicate_rows += key in seen
        seen.add(key)
    return {
        "ok": True,
        "dataRecords": count,
        "columns": len(header),
        "emptyHeaderPositions": [i + 1 for i, name in enumerate(names) if not name],
        "duplicateHeaderCount": len(names) - len(set(names)),
        "widthMismatchRecords": widths,
        "widthMismatchCount": width_count,
        "widthMismatchRecordsTruncated": width_count > len(widths),
        "blankCellsByColumn": blanks,
        "duplicateRecords": duplicate_rows,
        "possibleFormulaCells": formulas,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path")
    parser.add_argument("--delimiter", default=",")
    args = parser.parse_args()
    if len(args.delimiter) != 1 or args.delimiter in "\r\n\0":
        parser.error("delimiter must be one non-newline, non-NUL character")
    try:
        result = profile(args.path, args.delimiter)
    except (OSError, UnicodeError, csv.Error, ValueError):
        # Keep file paths, raw cells and decoder excerpts out of diagnostics.
        print(json.dumps({"ok": False, "error": "Cannot profile input: check readability, UTF-8 encoding, CSV syntax, header and the 10 MiB limit."}), file=sys.stderr)
        return 2
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
