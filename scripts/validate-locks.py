#!/usr/bin/env python3
"""Minimal structural and cross-reference checks for the SEZU 0.1.0 Phase 0 locks."""
from __future__ import annotations

import csv
import json
import re
import sys
import tomllib
import yaml
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCKS = ROOT / "locks"
REQUIRED = [
    "apt-host.tsv", "apt-u.tsv", "direct-artifacts.tsv", "npm-lock.json",
    "python-uv.lock", "playwright-browsers.json", "ubuntu-image.json",
    "capability-packs.json", "service-images.json", "licenses.json",
    "python-linux-amd64-artifacts.json",
]
HEX64 = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}(?:[0-9a-f]{24})?$")
MOVING = {"latest", "stable", "current", "main", "master", "head"}


def fail(message: str) -> None:
    raise AssertionError(message)


def load_json(name: str):
    return json.loads((LOCKS / name).read_text(encoding="utf-8"))


def load_tsv(name: str):
    with (LOCKS / name).open(encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f, delimiter="\t"))
    if not rows:
        fail(f"{name} has no data rows")
    return rows


def exact(value: str, where: str) -> None:
    if not value or value.strip().lower() in MOVING:
        fail(f"moving or empty effective version at {where}: {value!r}")
    if any(c in value for c in "*^<>"):
        fail(f"range-like effective version at {where}: {value}")


def main() -> int:
    for name in REQUIRED:
        p = LOCKS / name
        if not p.is_file() or p.stat().st_size == 0:
            fail(f"missing or empty lock: {name}")

    apt_host = load_tsv("apt-host.tsv")
    apt_u = load_tsv("apt-u.tsv")
    apt_required = {"package", "version", "architecture", "source", "package_url", "size", "sha256"}
    for lock_name, rows in (("apt-host.tsv", apt_host), ("apt-u.tsv", apt_u)):
        if not apt_required.issubset(rows[0]):
            fail(f"{lock_name} missing required columns")
        seen = set()
        for i, r in enumerate(rows, 2):
            key = (r["package"], r["version"], r["architecture"])
            if key in seen:
                fail(f"duplicate APT row {lock_name}:{i}: {key}")
            seen.add(key)
            exact(r["version"], f"{lock_name}:{i}")
            if not HEX64.fullmatch(r["sha256"]):
                fail(f"invalid APT digest {lock_name}:{i}")
            if not r["package_url"].startswith(("http://", "https://")):
                fail(f"invalid APT URL {lock_name}:{i}")
            if not r["size"].isdigit() or int(r["size"]) <= 0:
                fail(f"invalid APT size {lock_name}:{i}")

    ah = {(r["package"], r["version"]) for r in apt_host}
    au = {(r["package"], r["version"]) for r in apt_u}
    required_host = {
        ("linux-image-6.8.0-136-generic", "6.8.0-136.136"),
        ("incus", "1:6.0.6-ubuntu24.04-202603272003"),
        ("incus-base", "1:6.0.6-ubuntu24.04-202603272003"),
        ("incus-client", "1:6.0.6-ubuntu24.04-202603272003"),
    }
    if not required_host.issubset(ah):
        fail(f"host baseline missing: {sorted(required_host - ah)}")
    if ("docker.io", "29.1.3-0ubuntu3~24.04.2") not in au:
        fail("locked u Docker baseline is missing")

    direct = load_tsv("direct-artifacts.tsv")
    direct_required = {"component", "version", "architecture", "source_url", "size", "sha256", "pack"}
    if not direct_required.issubset(direct[0]):
        fail("direct-artifacts.tsv missing required columns")
    direct_by = {}
    for i, r in enumerate(direct, 2):
        if r["component"] in direct_by:
            fail(f"duplicate direct component: {r['component']}")
        direct_by[r["component"]] = r
        exact(r["version"], f"direct-artifacts.tsv:{i}")
        if not HEX64.fullmatch(r["sha256"]):
            fail(f"invalid direct digest at row {i}")
        if not r["source_url"].startswith("https://"):
            fail(f"non-HTTPS direct URL at row {i}")
        if not r["size"].isdigit() or int(r["size"]) <= 0:
            fail(f"invalid direct size at row {i}")
        if r.get("git_repository"):
            if not r.get("git_tag") or not COMMIT.fullmatch(r.get("git_commit", "")):
                fail(f"Git input lacks exact tag/commit at row {i}: {r['component']}")
    for component, version in {
        "nodejs": "24.19.0", "tunnel-client": "0.0.10",
    }.items():
        if direct_by.get(component, {}).get("version") != version:
            fail(f"direct baseline mismatch: {component} {version}")

    npm = load_json("npm-lock.json")
    if npm.get("lockfileVersion") != 3:
        fail("npm lockfileVersion must be 3")
    npm_packages = npm.get("packages", {})
    for path, entry in npm_packages.items():
        if path and "version" not in entry:
            fail(f"npm package lacks effective version: {path}")
        if path:
            exact(str(entry["version"]), f"npm:{path}")
            if entry.get("resolved", "").startswith("http://"):
                fail(f"npm package uses non-HTTPS source: {path}")
    roots = npm_packages.get("", {}).get("dependencies", {})
    for name, version in {"@modelcontextprotocol/sdk": "1.30.0", "playwright": "1.62.1"}.items():
        if roots.get(name) != version:
            fail(f"npm baseline mismatch: {name}")

    uv = tomllib.loads((LOCKS / "python-uv.lock").read_text(encoding="utf-8"))
    py_packages = uv.get("package", [])
    if not py_packages:
        fail("Python lock contains no packages")
    for p in py_packages:
        if "name" not in p or "version" not in p:
            fail(f"Python package lacks name/version: {p}")
        exact(str(p["version"]), f"python:{p['name']}")
        for artifact in ([p.get("sdist")] if p.get("sdist") else []) + p.get("wheels", []):
            h = artifact.get("hash", "")
            if not h.startswith("sha256:") or not HEX64.fullmatch(h.removeprefix("sha256:")):
                fail(f"Python artifact lacks SHA-256: {p['name']}")

    linux_python = load_json("python-linux-amd64-artifacts.json")
    if linux_python.get("platform") != "linux-amd64" or not linux_python.get("artifacts"):
        fail("Linux Python artifact supplement is invalid")
    for artifact in linux_python["artifacts"]:
        exact(str(artifact.get("version", "")), f"python-linux:{artifact.get('name')}")
        if not HEX64.fullmatch(artifact.get("sha256", "")) or not str(artifact.get("size", "")).isdigit():
            fail(f"invalid Linux Python artifact: {artifact.get('name')}")
        if not artifact.get("url", "").startswith("https://files.pythonhosted.org/"):
            fail(f"invalid Linux Python artifact URL: {artifact.get('name')}")

    browsers = load_json("playwright-browsers.json")
    if browsers.get("playwright_package_version") != "1.62.1":
        fail("Playwright package baseline mismatch")
    items = browsers.get("browsers", [])
    if len(items) != 1 or items[0].get("name") != "chromium":
        fail("browser lock must contain Chromium only")
    if not HEX64.fullmatch(items[0].get("sha256", "")):
        fail("Chromium artifact digest is invalid")
    text = json.dumps(browsers).lower()
    if '"name": "firefox"' in text or '"name": "webkit"' in text:
        fail("Firefox or WebKit is present in browser inputs")

    image = load_json("ubuntu-image.json")
    if image.get("serial") != "20260803_07:42" or image.get("architecture") != "amd64":
        fail("Ubuntu source image baseline mismatch")
    for field in ("metadata_fingerprint", "root_filesystem_fingerprint", "incus_image_fingerprint"):
        if not HEX64.fullmatch(image.get(field, "")):
            fail(f"Ubuntu image lacks immutable {field}")
    for a in image.get("artifacts", []):
        if not HEX64.fullmatch(a.get("sha256", "")) or not str(a.get("size", "")).isdigit():
            fail(f"invalid Ubuntu image artifact: {a}")

    caps = load_json("capability-packs.json")
    packs = caps.get("packs", [])
    ids = [p.get("pack_id") for p in packs]
    if len(ids) != len(set(ids)):
        fail("duplicate capability pack ID")
    base = [p for p in packs if p.get("placement") == "base"]
    langs = [p for p in packs if str(p.get("pack_id", "")).startswith("language-")]
    other = [p for p in packs if p.get("placement") == "on-demand" and p not in langs]
    if (len(base), len(langs), len(other), len(packs)) != (7, 17, 8, 32):
        fail(f"pack counts mismatch: {len(base)}, {len(langs)}, {len(other)}, {len(packs)}")
    for p in packs:
        if p.get("architecture") != "amd64" or not p.get("components"):
            fail(f"invalid pack: {p.get('pack_id')}")
        for c in p["components"]:
            exact(str(c.get("version", "")), f"pack:{p['pack_id']}:{c.get('component')}")
            lp = ROOT / c.get("lock_file", "")
            if not lp.is_file():
                fail(f"pack references missing lock: {p['pack_id']} {lp}")

    services = load_json("service-images.json").get("services", [])
    if len(services) != 17 or len({s.get("template_id") for s in services}) != 17:
        fail("service image count/IDs mismatch")
    for s in services:
        exact(str(s.get("version", "")), f"service:{s.get('template_id')}")
        if s.get("platform") != {"os": "linux", "architecture": "amd64"}:
            fail(f"service platform mismatch: {s.get('template_id')}")
        for field in ("platform_digest", "index_digest"):
            value = s.get(field, "")
            if not value.startswith("sha256:") or not HEX64.fullmatch(value.removeprefix("sha256:")):
                fail(f"service lacks immutable {field}: {s.get('template_id')}")
        if "@sha256:" not in s.get("immutable_reference", ""):
            fail(f"service lacks immutable reference: {s.get('template_id')}")
        template = ROOT / "templates" / "services" / f"{s['template_id']}.json"
        if not template.is_file():
            fail(f"service template file missing: {template.name}")
        json.loads(template.read_text(encoding="utf-8"))

    licenses = load_json("licenses.json")
    if not licenses.get("licenses"):
        fail("licenses.json has no metadata")

    # Parse the canonical JSON schemas and minimally parse the constrained capabilities YAML.
    for p in (ROOT / "config").glob("*.json"):
        json.loads(p.read_text(encoding="utf-8"))
    cap_yaml = (ROOT / "config" / "capabilities.yaml").read_text(encoding="utf-8")
    parsed_yaml = yaml.safe_load(cap_yaml)
    if not isinstance(parsed_yaml, dict):
        fail("capabilities YAML did not parse to an object")
    for token in ("base_packs:", "on_demand_packs:", "service_templates:", "excluded:"):
        if token not in cap_yaml:
            fail(f"capabilities YAML missing section: {token}")

    effective_names = set(r["package"].lower() for r in apt_host + apt_u)
    effective_names |= set(r["component"].lower() for r in direct)
    effective_names |= {p["name"].lower() for p in py_packages}
    effective_names |= {k.removeprefix("node_modules/").lower() for k in npm_packages if k}
    forbidden = ("android-sdk", "android-ndk", "adb", "fastboot", "apktool", "jadx", "ollama", "vllm", "local-llm")
    for name in effective_names:
        if any(name == x or name.startswith(x + "-") for x in forbidden):
            fail(f"excluded input present: {name}")

    for p in ROOT.rglob("*"):
        if not p.is_file() or ".git" in p.parts:
            continue
        data = p.read_bytes()
        if re.search(rb"(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})", data):
            fail(f"credential-like token found: {p.relative_to(ROOT)}")

    print(json.dumps({
        "host_packages": len(apt_host), "u_packages": len(apt_u),
        "direct_artifacts": len(direct), "npm_packages": len(npm_packages) - 1,
        "python_packages": len(py_packages), "capability_packs": len(packs),
        "service_images": len(services),
    }, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, KeyError, ValueError, json.JSONDecodeError) as exc:
        print(f"lock validation failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
