"""Read-only, bounded comparison of two npm tarballs; never extracts members."""

import hashlib
import gzip
import io
import json
from pathlib import PurePosixPath
import sys
import tarfile
import zlib

MAX_ARCHIVE = 32 * 1024 * 1024
MAX_TOTAL = 64 * 1024 * 1024
MAX_FILE = 8 * 1024 * 1024
MAX_MEMBERS = 4096
MAX_OUTPUT = 64 * 1024


def category(name):
    if name.endswith(".map"):
        return "source-map"
    if name.endswith(".d.ts"):
        return "declaration"
    if name.endswith((".md", ".txt")):
        return "documentation"
    if name.endswith((".js", ".mjs", ".cjs")):
        return "code"
    return "other"


def inventory(path):
    with open(path, "rb") as stream:
        compressed = stream.read(MAX_ARCHIVE + 1)
        size = len(compressed)
        if size > MAX_ARCHIVE:
            raise ValueError("Archive exceeds size limit")
        artifact_hash = hashlib.sha256(compressed).hexdigest()
        with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as inflated:
            raw = inflated.read(MAX_TOTAL + 1)
        if len(raw) > MAX_TOTAL:
            raise ValueError("Archive exceeds expanded size limit")
        files, seen, total, identity = {}, set(), 0, None
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
            for index, member in enumerate(archive):
                if index >= MAX_MEMBERS:
                    raise ValueError("Archive exceeds member limit")
                name = member.name.rstrip("/") if member.isdir() else member.name
                parts = name.split("/")
                if (
                    name in seen
                    or PurePosixPath(name).is_absolute()
                    or "\\" in name
                    or any(part in ("", ".", "..") for part in parts)
                    or parts[0] != "package"
                ):
                    raise ValueError("Invalid or duplicate package member")
                seen.add(name)
                if member.isdir():
                    continue
                if not member.isfile() or member.size < 0 or member.size > MAX_FILE:
                    raise ValueError("Unsupported package member")
                total += member.size
                if total > MAX_TOTAL:
                    raise ValueError("Archive exceeds expanded size limit")
                source = archive.extractfile(member)
                if source is None:
                    raise ValueError("Unreadable package member")
                with source:
                    data = source.read(MAX_FILE + 1)
                if len(data) != member.size:
                    raise ValueError("Incomplete package member")
                files[name] = {
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "bytes": len(data),
                    "mode": member.mode & 0o7777,
                    "category": category(name),
                }
                if name == "package/package.json":
                    metadata = json.loads(data)
                    identity = {key: metadata.get(key) for key in ("name", "version")}
                    if not all(isinstance(value, str) and value for value in identity.values()):
                        raise ValueError("Invalid package identity")
            trailer = raw[archive.offset:]
            if len(trailer) < 1024 or any(trailer):
                raise ValueError("Incomplete or trailing archive data")
        if identity is None:
            raise ValueError("Missing package identity")
    return {"sha256": artifact_hash, "bytes": size, "identity": identity, "files": files}


def compare(before, after):
    old, new = inventory(before), inventory(after)
    a, b = old["files"], new["files"]
    return {
        "before": old,
        "after": new,
        "added": sorted(b.keys() - a.keys()),
        "removed": sorted(a.keys() - b.keys()),
        "changed": sorted(name for name in a.keys() & b.keys() if a[name] != b[name]),
        "contentChanged": sorted(name for name in a.keys() & b.keys() if a[name]["sha256"] != b[name]["sha256"]),
        "metadataChanged": sorted(name for name in a.keys() & b.keys() if a[name]["mode"] != b[name]["mode"]),
        "semanticChangesVerified": False,
    }


def compact(result):
    """Project a complete comparison, omitting only unchanged member records."""
    names = sorted(set(result["added"] + result["removed"] + result["changed"]))
    return {
        "format": "artifact-delta-brief.compact.v1",
        "before": {**{k: v for k, v in result["before"].items() if k != "files"},
                   "fileCount": len(result["before"]["files"])},
        "after": {**{k: v for k, v in result["after"].items() if k != "files"},
                  "fileCount": len(result["after"]["files"])},
        **{k: result[k] for k in ("added", "removed", "changed", "contentChanged",
                                 "metadataChanged", "semanticChangesVerified")},
        "members": {name: {"before": result["before"]["files"].get(name),
                           "after": result["after"]["files"].get(name)} for name in names},
        "memberRecords": "All added, removed, content-changed and mode-changed members; unchanged records omitted.",
    }


if __name__ == "__main__":
    try:
        full = len(sys.argv) == 4 and sys.argv[3] == "--full"
        if len(sys.argv) != 3 and not full:
            raise ValueError("Expected before and after tarballs, optionally --full")
        result = compare(sys.argv[1], sys.argv[2])
        encoded = json.dumps(result if full else compact(result), ensure_ascii=False)
        if not full and len((encoded + "\n").encode("utf-8")) > MAX_OUTPUT:
            raise OverflowError("Complete compact result exceeds stdout limit")
        print(encoded)
    except OverflowError:
        print(json.dumps({"error": "Complete comparison exceeds 64 KiB; use --full with permitted local storage. No partial result."}), file=sys.stderr)
        sys.exit(2)
    except (OSError, EOFError, ValueError, TypeError, AttributeError, tarfile.TarError, zlib.error):
        print(json.dumps({"error": "Cannot compare complete supported npm artifacts; no partial result."}), file=sys.stderr)
        sys.exit(2)
