import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("compares complete package payloads without extraction and rejects unsupported inputs", () => {
  const output = execFileSync(
    "python3",
    [
      "-c",
      `
import gzip, importlib.util, io, json, pathlib, tarfile, tempfile
spec = importlib.util.spec_from_file_location("compare", "skills/artifact-delta-brief/scripts/compare.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def archive(path, entries):
    with tarfile.open(path, "w:gz") as tar:
        for name, data, mode, kind in entries:
            info = tarfile.TarInfo(name)
            info.mode, info.type = mode, kind
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
regular = tarfile.REGTYPE
identity = ("package/package.json", b'{"name":"example","version":"1.0.0"}', 0o644, regular)
def entry(name, data=b"old", mode=0o644, kind=regular):
    return (name, data, mode, kind)
def rejects(path):
    try:
        module.inventory(path)
    except (ValueError, tarfile.TarError):
        return
    raise AssertionError("unsupported archive accepted")
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    a, b = root / "a.tgz", root / "b.tgz"
    archive(a, [identity, entry("package/a.js"), entry("package/remove.txt"), entry("package/mode.js")])
    archive(b, [identity, entry("package/a.js", b"new"), entry("package/add.txt"), entry("package/mode.js", mode=0o755)])
    result = module.compare(a, b)
    assert result["added"] == ["package/add.txt"]
    assert result["removed"] == ["package/remove.txt"]
    assert result["contentChanged"] == ["package/a.js"]
    assert result["metadataChanged"] == ["package/mode.js"]
    assert result["semanticChangesVerified"] is False
    assert result["before"]["identity"] == result["after"]["identity"]
    assert result["before"]["sha256"] != result["after"]["sha256"]
    assert module.compare(a, a)["changed"] == []
    raw = gzip.decompress(a.read_bytes())
    for payload in [raw + raw, raw + b"hidden", raw[:512]]:
        b.write_bytes(gzip.compress(payload))
        rejects(b)
    b.write_bytes(gzip.compress(raw, mtime=1))
    repacked = module.compare(a, b)
    assert repacked["changed"] == []
    assert repacked["before"]["sha256"] != repacked["after"]["sha256"]
    for extra in [entry("package/a", kind=tarfile.SYMTYPE), entry("/package/a"), entry("package/../a"), identity]:
        archive(b, [identity, extra])
        rejects(b)
    archive(b, [entry("package/a")])
    rejects(b)
    archive(b, [identity, entry("package/big", b"12345")])
    module.MAX_FILE = 4
    rejects(b)
    module.MAX_FILE = 8 * 1024 * 1024
    module.MAX_TOTAL = 10
    rejects(b)
    module.MAX_TOTAL = 64 * 1024 * 1024
    module.MAX_MEMBERS = 1
    rejects(b)
    assert sorted(p.name for p in root.iterdir()) == ["a.tgz", "b.tgz"]
print("verified")
`,
    ],
    { encoding: "utf8" },
  );
  expect(output.trim()).toBe("verified");
});
