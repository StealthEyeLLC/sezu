#!/usr/bin/env python3
"""Derive deterministic Phase 3 base-install and on-demand cache manifests."""
from __future__ import annotations

import csv
import hashlib
import json
import re
import sys
import tomllib
from collections import defaultdict, deque
from pathlib import Path
from urllib.parse import unquote, urlparse

from packaging.markers import Marker, default_environment
from packaging.tags import sys_tags
from packaging.utils import canonicalize_name, parse_wheel_filename
from packaging.version import Version

ROOT = Path(__file__).resolve().parents[1]
LOCKS = ROOT / "locks"
OUT = ROOT / "config" / "forge"
BASE_PACKS = (
    "sezu-core", "data-core", "document-core", "wasm-core",
    "network-core", "machine-image-core", "cross-build-core",
)


def dump(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def marker_applies(text: str | None) -> bool:
    if not text:
        return True
    env = default_environment()
    env.update({
        "implementation_name": "cpython",
        "platform_python_implementation": "CPython",
        "python_version": "3.12",
        "python_full_version": "3.12.3",
        "sys_platform": "linux",
        "platform_system": "Linux",
        "os_name": "posix",
    })
    try:
        return Marker(text).evaluate(env)
    except Exception as exc:
        raise RuntimeError(f"cannot evaluate marker {text!r}: {exc}") from exc


def load_rows(name: str) -> list[dict[str, str]]:
    with (LOCKS / name).open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f, delimiter="\t"))


def npm_name(path: str) -> str:
    parts = path.split("/node_modules/")[-1].split("/")
    if parts[0].startswith("@"):
        return "/".join(parts[:2])
    return parts[0]


def npm_parent(path: str) -> str:
    if "/node_modules/" in path:
        return path.rsplit("/node_modules/", 1)[0]
    return ""


def npm_resolve(packages: dict[str, dict], parent: str, name: str) -> str | None:
    cur = parent
    while True:
        candidate = f"{cur}/node_modules/{name}" if cur else f"node_modules/{name}"
        if candidate in packages:
            return candidate
        if not cur:
            return None
        cur = npm_parent(cur)


def npm_closure(lock: dict, root_names: set[str]) -> dict:
    packages: dict[str, dict] = lock["packages"]
    root = json.loads(json.dumps(packages[""]))
    all_roots = root.get("dependencies", {})
    root["dependencies"] = {k: all_roots[k] for k in sorted(root_names)}
    queue: deque[str] = deque()
    seen: set[str] = set()
    for name in sorted(root_names):
        path = npm_resolve(packages, "", name)
        if path is None:
            raise RuntimeError(f"npm root is absent from lock: {name}")
        queue.append(path)
    while queue:
        path = queue.popleft()
        if path in seen:
            continue
        seen.add(path)
        entry = packages[path]
        edges: dict[str, str] = {}
        edges.update(entry.get("dependencies", {}))
        edges.update(entry.get("optionalDependencies", {}))
        peer_meta = entry.get("peerDependenciesMeta", {})
        for name, value in entry.get("peerDependencies", {}).items():
            if not peer_meta.get(name, {}).get("optional", False):
                edges.setdefault(name, value)
        for name in edges:
            resolved = npm_resolve(packages, path, name)
            if resolved is not None:
                queue.append(resolved)
    out = {k: v for k, v in lock.items() if k != "packages"}
    out["packages"] = {"": root}
    for path in sorted(seen):
        out["packages"][path] = packages[path]
    return out


def python_index(uv: dict) -> tuple[dict[tuple[str, str], dict], dict[str, list[dict]]]:
    exact: dict[tuple[str, str], dict] = {}
    by_name: dict[str, list[dict]] = defaultdict(list)
    for p in uv["package"]:
        name = canonicalize_name(p["name"])
        exact[(name, str(p["version"]))] = p
        by_name[name].append(p)
    return exact, by_name


def python_select_node(dep: dict, exact: dict, by_name: dict) -> dict:
    name = canonicalize_name(dep["name"])
    if dep.get("version"):
        key = (name, str(dep["version"]))
        if key not in exact:
            raise RuntimeError(f"Python dependency missing from lock: {key}")
        return exact[key]
    candidates = by_name.get(name, [])
    applicable = [p for p in candidates if any(marker_applies(m) for m in p.get("resolution-markers", [None]))]
    if len(applicable) == 1:
        return applicable[0]
    if len(candidates) == 1:
        return candidates[0]
    raise RuntimeError(f"ambiguous Python dependency {name}: {[p['version'] for p in candidates]}")


def python_closure(root_versions: dict[str, str], uv: dict) -> list[dict]:
    exact, by_name = python_index(uv)
    queue: deque[tuple[dict, frozenset[str]]] = deque()
    for name, version in sorted(root_versions.items()):
        key = (canonicalize_name(name), str(version))
        if key not in exact:
            raise RuntimeError(f"Python root missing from lock: {key}")
        queue.append((exact[key], frozenset()))
    seen: dict[tuple[str, str], dict] = {}
    processed_extras: dict[tuple[str, str], set[str]] = {}
    while queue:
        p, requested_extras = queue.popleft()
        key = (canonicalize_name(p["name"]), str(p["version"]))
        first_visit = key not in seen
        if first_visit:
            seen[key] = p
        already_processed = processed_extras.setdefault(key, set())
        new_extras = set(requested_extras) - already_processed
        if not first_visit and not new_extras:
            continue
        if first_visit:
            for dep in p.get("dependencies", []):
                if marker_applies(dep.get("marker")):
                    queue.append((python_select_node(dep, exact, by_name), frozenset(map(str, dep.get("extra", [])))))
        optional = p.get("optional-dependencies", {})
        for extra in sorted(new_extras):
            for dep in optional.get(extra, []):
                if marker_applies(dep.get("marker")):
                    queue.append((python_select_node(dep, exact, by_name), frozenset(map(str, dep.get("extra", [])))))
        already_processed.update(new_extras)
    return [seen[k] for k in sorted(seen)]



def prefer_newest_by_name(packages: list[dict]) -> list[dict]:
    selected: dict[str, dict] = {}
    for package in packages:
        name = canonicalize_name(package["name"])
        current = selected.get(name)
        if current is None or Version(str(package["version"])) > Version(str(current["version"])):
            selected[name] = package
    return [selected[name] for name in sorted(selected)]

def choose_python_artifact(package: dict, supported_tags: set) -> dict:
    compatible: list[tuple[int, dict]] = []
    for wheel in package.get("wheels", []):
        filename = unquote(Path(urlparse(wheel["url"]).path).name)
        try:
            _, _, _, tags = parse_wheel_filename(filename)
        except Exception:
            continue
        overlap = set(supported_tags).intersection(tags)
        if overlap:
            rank = min(supported_tags[t] for t in overlap)
            compatible.append((rank, wheel))
    if compatible:
        artifact = min(compatible, key=lambda x: (x[0], int(x[1]["size"]), x[1]["url"]))[1]
        kind = "wheel"
    elif package.get("sdist"):
        artifact = package["sdist"]
        kind = "sdist"
    else:
        raise RuntimeError(f"no Linux amd64 artifact for {package['name']} {package['version']}")
    digest = artifact["hash"].removeprefix("sha256:")
    return {
        "name": canonicalize_name(package["name"]),
        "version": str(package["version"]),
        "kind": kind,
        "url": artifact["url"],
        "size": int(artifact["size"]),
        "sha256": digest,
        "filename": unquote(Path(urlparse(artifact["url"]).path).name),
    }


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    caps = json.loads((LOCKS / "capability-packs.json").read_text())
    packs = {p["pack_id"]: p for p in caps["packs"]}
    if tuple(p["pack_id"] for p in caps["packs"] if p["placement"] == "base") != BASE_PACKS:
        raise RuntimeError("canonical base-pack order changed")
    on_demand = tuple(p["pack_id"] for p in caps["packs"] if p["placement"] == "on-demand")
    if len(on_demand) != 25:
        raise RuntimeError("expected 25 on-demand packs")

    apt_rows = load_rows("apt-u.tsv")
    apt_by = {(r["package"], r["architecture"]): r for r in apt_rows}
    direct_rows = load_rows("direct-artifacts.tsv")
    direct_by = {r["component"]: r for r in direct_rows}

    base_components = [c for pid in BASE_PACKS for c in packs[pid]["components"]]
    base_apt_refs: dict[tuple[str, str], dict] = {}
    base_direct: dict[str, dict] = {}
    base_npm_roots: set[str] = set()
    base_python_roots: dict[str, str] = {}
    for c in base_components:
        eco = c["ecosystem"]
        if eco == "apt":
            match = re.fullmatch(r"package=([^;]+);architecture=(.+)", c["lock_ref"])
            if not match:
                raise RuntimeError(f"bad APT lock ref: {c}")
            key = (match.group(1), match.group(2))
            row = apt_by.get(key)
            if not row or row["version"] != str(c["version"]):
                raise RuntimeError(f"APT root mismatch: {c}")
            base_apt_refs[key] = row
        elif eco == "direct":
            row = direct_by.get(c["component"])
            if not row or row["version"] != str(c["version"]):
                raise RuntimeError(f"direct root mismatch: {c}")
            base_direct[c["component"]] = row
        elif eco == "npm":
            base_npm_roots.add(c["component"])
        elif eco == "python":
            base_python_roots[c["component"]] = str(c["version"])

    with (OUT / "base-apt-roots.tsv").open("w", encoding="utf-8", newline="") as f:
        fields = list(apt_rows[0])
        w = csv.DictWriter(f, fields, delimiter="\t", lineterminator="\n")
        w.writeheader()
        for row in sorted(base_apt_refs.values(), key=lambda r: (r["package"], r["architecture"])):
            w.writerow(row)
    for filename, rows in (
        ("base-direct.tsv", [base_direct[k] for k in sorted(base_direct)]),
        ("on-demand-direct.tsv", [r for r in direct_rows if r["pack"] in on_demand]),
    ):
        with (OUT / filename).open("w", encoding="utf-8", newline="") as f:
            fields = list(direct_rows[0])
            w = csv.DictWriter(f, fields, delimiter="\t", lineterminator="\n")
            w.writeheader(); w.writerows(rows)

    npm = json.loads((LOCKS / "npm-lock.json").read_text())
    base_npm = npm_closure(npm, base_npm_roots)
    base_npm["name"] = "sezu-base-forge"
    base_npm["version"] = "0.1.0"
    base_npm["packages"][""]["name"] = "sezu-base-forge"
    base_npm["packages"][""]["version"] = "0.1.0"
    base_pkg = {
        "name": "sezu-base-forge",
        "version": "0.1.0",
        "private": True,
        "engines": {"node": "24.19.0"},
        "dependencies": base_npm["packages"][""]["dependencies"],
    }
    dump(OUT / "base-npm-package.json", base_pkg)
    dump(OUT / "base-npm-lock.json", base_npm)

    uv = tomllib.loads((LOCKS / "python-uv.lock").read_text())
    corrections = json.loads((LOCKS / "python-linux-amd64-artifacts.json").read_text())
    correction_map = {(canonicalize_name(x["name"]), str(x["version"])): x for x in corrections["artifacts"]}
    for package in uv["package"]:
        correction = correction_map.get((canonicalize_name(package["name"]), str(package["version"])))
        if correction:
            wheel = {
                "url": correction["url"],
                "hash": "sha256:" + correction["sha256"],
                "size": correction["size"],
                "upload-time": correction["upload_time"],
            }
            package.setdefault("wheels", []).append(wheel)
    primary_python_roots = dict(base_python_roots)
    document_python_roots = {"ocrmypdf": primary_python_roots.pop("ocrmypdf")}
    python_environments = {
        "data-core": python_closure(primary_python_roots, uv),
        "document-core": prefer_newest_by_name(python_closure(document_python_roots, uv)),
    }
    all_root_versions: dict[str, str] = {}
    for p in caps["packs"]:
        for c in p["components"]:
            if c["ecosystem"] == "python":
                all_root_versions[c["component"]] = str(c["version"])
    all_py = python_closure(all_root_versions, uv)
    tag_rank = {tag: i for i, tag in enumerate(sys_tags())}
    base_plan = []
    environment_summary = {}
    for environment, packages in python_environments.items():
        selected = [choose_python_artifact(p, tag_rank) for p in packages]
        for artifact in selected:
            artifact["environment"] = environment
        base_plan.extend(selected)
        environment_summary[environment] = {
            "package_count": len(selected),
            "roots": document_python_roots if environment == "document-core" else primary_python_roots,
        }
    all_plan = [choose_python_artifact(p, tag_rank) for p in all_py]
    base_keys = {(x["name"], x["version"]) for x in base_plan}
    for x in all_plan:
        x["base"] = (x["name"], x["version"]) in base_keys
    dump(OUT / "base-python-plan.json", base_plan)
    dump(OUT / "all-python-plan.json", all_plan)

    cache_index = {
        "schema_version": 1,
        "release": "0.1.0",
        "base_packs": list(BASE_PACKS),
        "on_demand_packs": list(on_demand),
        "packs": {},
    }
    for pid, p in packs.items():
        cache_index["packs"][pid] = {
            "placement": p["placement"],
            "components": [
                {k: c[k] for k in ("component", "version", "ecosystem", "lock_file", "lock_ref")}
                for c in p["components"]
            ],
        }
    dump(OUT / "pack-cache-index.json", cache_index)
    existing_golden = None
    phase3_path = OUT / "phase3.json"
    if phase3_path.exists():
        try:
            value = json.loads(phase3_path.read_text()).get("golden_fingerprint")
            if isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value):
                existing_golden = value
        except (OSError, ValueError):
            pass
    phase3 = {
        "schema_version": 1,
        "release": "0.1.0",
        "project": "sezu",
        "profile": "sezu-u-power",
        "build_instance": "u-build",
        "production_instance": "u",
        "golden_alias": "sezu-u-golden-0.1.0",
        "source_image_fingerprint": json.loads((LOCKS / "ubuntu-image.json").read_text())["incus_image_fingerprint"],
        "base_packs": list(BASE_PACKS),
        "on_demand_pack_count": len(on_demand),
        "base_apt_root_count": len(base_apt_refs),
        "base_direct_count": len(base_direct),
        "base_npm_root_count": len(base_npm_roots),
        "base_npm_package_count": len(base_npm["packages"]) - 1,
        "base_python_root_count": len(base_python_roots),
        "base_python_package_count": len(base_plan),
        "base_python_environments": environment_summary,
        "all_python_cached_package_count": len(all_plan),
        "golden_fingerprint": existing_golden,
    }
    dump(phase3_path, phase3)
    print(json.dumps(phase3, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"phase3 pack selection failed: {exc}", file=sys.stderr)
        raise
