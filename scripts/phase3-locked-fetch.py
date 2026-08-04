#!/usr/bin/env python3
"""Fetch and verify immutable Phase 3 inputs into the persistent u cache."""
from __future__ import annotations

import argparse
import concurrent.futures
import csv
import hashlib
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(4 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def valid(path: Path, size: int, digest: str) -> bool:
    return path.is_file() and path.stat().st_size == size and sha256(path) == digest


def fetch_one(item: dict, destination: Path) -> Path:
    destination.parent.mkdir(parents=True, exist_ok=True)
    size = int(item["size"])
    digest = item["sha256"].removeprefix("sha256:")
    if valid(destination, size, digest):
        return destination
    part = destination.with_name(destination.name + ".part")
    for attempt in range(1, 7):
        try:
            start = part.stat().st_size if part.exists() else 0
            headers = {"User-Agent": "sezu-phase3/0.1.0"}
            if start:
                headers["Range"] = f"bytes={start}-"
            request = urllib.request.Request(item["url"], headers=headers)
            with urllib.request.urlopen(request, timeout=120) as response:
                status = getattr(response, "status", 200)
                mode = "ab" if start and status == 206 else "wb"
                if mode == "wb":
                    start = 0
                with part.open(mode) as out:
                    shutil.copyfileobj(response, out, 4 * 1024 * 1024)
            if part.stat().st_size != size:
                raise RuntimeError(f"size {part.stat().st_size} != {size}")
            actual = sha256(part)
            if actual != digest:
                raise RuntimeError(f"sha256 {actual} != {digest}")
            os.replace(part, destination)
            return destination
        except Exception as exc:
            if attempt == 6:
                raise RuntimeError(f"download failed {item['url']}: {exc}") from exc
            if part.exists() and part.stat().st_size > size:
                part.unlink()
            time.sleep(min(20, attempt * 2))
    raise AssertionError("unreachable")


def safe_name(text: str) -> str:
    return "".join(c if c.isalnum() or c in ".@_+-" else "_" for c in text)


def run_parallel(tasks: list[tuple[dict, Path]], workers: int) -> None:
    total = len(tasks)
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(fetch_one, item, dest): (item, dest) for item, dest in tasks}
        for future in concurrent.futures.as_completed(futures):
            item, dest = futures[future]
            future.result()
            done += 1
            if done == total or done % 50 == 0:
                print(f"fetched {done}/{total}: {dest.name}", flush=True)


def read_tsv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f, delimiter="\t"))


def apt(cache: Path, workers: int) -> None:
    rows = read_tsv(ROOT / "locks" / "apt-u.tsv")
    store = cache / "sources" / "apt" / "artifacts"
    tasks: list[tuple[dict, Path]] = []
    index: list[dict] = []
    for row in rows:
        filename = urllib.parse.unquote(Path(urllib.parse.urlparse(row["package_url"]).path).name)
        dest = store / f"{row['sha256']}-{filename}"
        item = {"url": row["package_url"], "size": row["size"], "sha256": row["sha256"]}
        tasks.append((item, dest))
        index.append({**row, "cache_path": str(dest)})
    run_parallel(tasks, workers)
    out = cache / "sources" / "apt" / "locked-index.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(index, indent=2, sort_keys=True) + "\n")


def direct(cache: Path, workers: int) -> None:
    rows = read_tsv(ROOT / "locks" / "direct-artifacts.tsv")
    allowed = [r for r in rows if r["pack"] != "sezu-runtime"]
    store = cache / "sources" / "direct" / "artifacts"
    tasks: list[tuple[dict, Path]] = []
    index: list[dict] = []
    for row in allowed:
        filename = urllib.parse.unquote(Path(urllib.parse.urlparse(row["source_url"]).path).name)
        dest = store / f"{row['sha256']}-{filename}"
        item = {"url": row["source_url"], "size": row["size"], "sha256": row["sha256"]}
        tasks.append((item, dest))
        index.append({**row, "cache_path": str(dest)})
    run_parallel(tasks, workers)
    out = cache / "sources" / "direct" / "locked-index.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(index, indent=2, sort_keys=True) + "\n")


def python(cache: Path, workers: int) -> None:
    plan = json.loads((ROOT / "config" / "forge" / "all-python-plan.json").read_text())
    store = cache / "sources" / "python" / "artifacts"
    tasks: list[tuple[dict, Path]] = []
    index: list[dict] = []
    for row in plan:
        dest = store / f"{row['sha256']}-{row['filename']}"
        tasks.append((row, dest))
        index.append({**row, "cache_path": str(dest)})
    run_parallel(tasks, workers)
    out = cache / "sources" / "python" / "locked-index.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(index, indent=2, sort_keys=True) + "\n")


def image(cache: Path) -> None:
    lock = json.loads((ROOT / "locks" / "ubuntu-image.json").read_text())
    rows = []
    for artifact in lock["artifacts"]:
        if artifact["role"] not in ("metadata", "rootfs-tar-xz"):
            continue
        filename = urllib.parse.unquote(Path(urllib.parse.urlparse(artifact["url"]).path).name)
        dest = cache / "sources" / "images" / f"{artifact['sha256']}-{filename}"
        item = {"url": artifact["url"], "size": artifact["size"], "sha256": artifact["sha256"]}
        fetch_one(item, dest)
        rows.append({**artifact, "cache_path": str(dest)})
    out = cache / "sources" / "images" / "locked-index.json"
    out.write_text(json.dumps(rows, indent=2, sort_keys=True) + "\n")


def browser(cache: Path) -> None:
    lock = json.loads((ROOT / "locks" / "playwright-browsers.json").read_text())
    rows = []
    for b in lock["browsers"]:
        filename = urllib.parse.unquote(Path(urllib.parse.urlparse(b["artifact_url"]).path).name)
        dest = cache / "sources" / "playwright" / f"{b['sha256']}-{filename}"
        item = {"url": b["artifact_url"], "size": b["size"], "sha256": b["sha256"]}
        fetch_one(item, dest)
        rows.append({**b, "cache_path": str(dest)})
    out = cache / "sources" / "playwright" / "locked-index.json"
    out.write_text(json.dumps(rows, indent=2, sort_keys=True) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("kind", choices=("apt", "direct", "python", "browser", "image", "all"))
    parser.add_argument("--cache", default="/cache/sezu")
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    cache = Path(args.cache)
    if args.kind in ("apt", "all"):
        apt(cache, args.workers)
    if args.kind in ("direct", "all"):
        direct(cache, args.workers)
    if args.kind in ("python", "all"):
        python(cache, args.workers)
    if args.kind in ("browser", "all"):
        browser(cache)
    if args.kind in ("image", "all"):
        image(cache)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
