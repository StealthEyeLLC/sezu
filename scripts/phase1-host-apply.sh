#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source "$ROOT/config/host/phase1.conf"
LOCK="$ROOT/locks/apt-host.tsv"
STAGE=/var/tmp/sezu-phase1-apt

if [[ $EUID -ne 0 ]]; then
  echo "phase1-host-apply.sh must run as root" >&2
  exit 1
fi

. /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]] || { echo "Ubuntu 24.04 is required" >&2; exit 1; }
[[ $(dpkg --print-architecture) == amd64 ]] || { echo "amd64 is required" >&2; exit 1; }
grep -q '^Vendor ID:[[:space:]]*GenuineIntel$' < <(lscpu) || { echo "the locked target requires Intel KVM" >&2; exit 1; }

python3 "$ROOT/scripts/validate-locks.py"
dpkg --configure -a
apt-get check >/dev/null

rm -rf "$STAGE"
install -d -m 0700 "$STAGE"
python3 - "$LOCK" "$STAGE" <<'PY'
import csv
import hashlib
import shutil
import subprocess
import sys
import urllib.parse
from pathlib import Path

lock_path = Path(sys.argv[1])
stage = Path(sys.argv[2])
rows = list(csv.DictReader(lock_path.open(encoding="utf-8"), delimiter="\t"))
installed = {}
query = subprocess.run(
    ["dpkg-query", "-W", "-f=${Package}\t${Version}\n"],
    text=True,
    capture_output=True,
    check=True,
).stdout
for line in query.splitlines():
    if "\t" in line:
        package, version = line.split("\t", 1)
        installed[package] = version

cache_roots = [
    Path("/var/cache/sezu/sources/apt"),
    Path("/var/cache/sezu/sources/apt-repository/pool"),
]

def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def valid(path: Path, row: dict[str, str]) -> bool:
    return path.is_file() and path.stat().st_size == int(row["size"]) and digest(path) == row["sha256"]

paths = []
for row in rows:
    if installed.get(row["package"]) == row["version"]:
        continue
    filename = urllib.parse.unquote(row["package_url"].rsplit("/", 1)[-1])
    destination = stage / filename
    source = None
    for root in cache_roots:
        if not root.exists():
            continue
        for candidate in root.rglob(filename):
            if valid(candidate, row):
                source = candidate
                break
        if source is not None:
            break
    if source is not None:
        shutil.copy2(source, destination)
    else:
        partial = destination.with_suffix(destination.suffix + ".partial")
        subprocess.run(
            ["curl", "--fail", "--location", "--retry", "3", "--output", str(partial), row["package_url"]],
            check=True,
        )
        partial.replace(destination)
    if not valid(destination, row):
        raise SystemExit(f"locked package verification failed: {row['package']} {row['version']}")
    paths.append(str(destination))

(stage / "packages.txt").write_text("".join(path + "\n" for path in paths), encoding="utf-8")
print(f"locked package delta prepared: {len(paths)}")
PY

mapfile -t packages < "$STAGE/packages.txt"
if ((${#packages[@]})); then
  if ! DEBIAN_FRONTEND=noninteractive dpkg -i "${packages[@]}"; then
    dpkg --configure -a
  fi
fi
dpkg --configure -a
apt-get check >/dev/null

python3 - "$LOCK" <<'PY'
import csv
import subprocess
import sys
rows = list(csv.DictReader(open(sys.argv[1], encoding="utf-8"), delimiter="\t"))
installed = {}
for line in subprocess.run(
    ["dpkg-query", "-W", "-f=${Package}\t${Version}\n"],
    text=True,
    capture_output=True,
    check=True,
).stdout.splitlines():
    if "\t" in line:
        package, version = line.split("\t", 1)
        installed[package] = version
bad = [(row["package"], row["version"], installed.get(row["package"])) for row in rows if installed.get(row["package"]) != row["version"]]
if bad:
    for package, wanted, got in bad:
        print(f"locked package mismatch: {package}: wanted {wanted}, got {got}", file=sys.stderr)
    raise SystemExit(1)
print(f"locked host packages installed: {len(rows)}")
PY

if ! getent group sezu >/dev/null; then
  groupadd --system sezu
fi
if ! getent passwd sezu-tunnel >/dev/null; then
  useradd --system --gid sezu --home-dir /nonexistent --no-create-home --shell /usr/sbin/nologin sezu-tunnel
fi
if ! id -nG sezu-tunnel | tr ' ' '\n' | grep -qx sezu; then
  usermod -a -G sezu sezu-tunnel
fi

install -D -m 0644 "$ROOT/systemd/modules-load/sezu.conf" /etc/modules-load.d/sezu.conf
install -D -m 0644 "$ROOT/systemd/sysctl/sezu.conf" /etc/sysctl.d/90-sezu.conf
install -D -m 0644 "$ROOT/systemd/tmpfiles/sezu.conf" /etc/tmpfiles.d/sezu.conf
install -D -m 0644 "$ROOT/systemd/zram-generator.conf" /etc/systemd/zram-generator.conf
install -D -m 0644 "$ROOT/config/host/limits.conf" /etc/security/limits.d/90-sezu.conf

current_kernel=$(uname -r)
while IFS= read -r module; do
  [[ -n $module && $module != \#* ]] || continue
  if ! modprobe "$module"; then
    if [[ $current_kernel != "$SEZU_REQUIRED_KERNEL" ]] && modinfo -k "$SEZU_REQUIRED_KERNEL" "$module" >/dev/null 2>&1; then
      echo "module deferred until reboot into $SEZU_REQUIRED_KERNEL: $module"
      continue
    fi
    [[ -d /sys/module/${module//-/_} ]] || { echo "required module unavailable: $module" >&2; exit 1; }
  fi
done < "$ROOT/systemd/modules-load/sezu.conf"

sysctl --system >/dev/null
systemd-tmpfiles --create /etc/tmpfiles.d/sezu.conf

if [[ ! -e $SEZU_STORAGE_BACKING ]]; then
  truncate -s "$SEZU_STORAGE_SIZE_BYTES" "$SEZU_STORAGE_BACKING"
  chmod 0600 "$SEZU_STORAGE_BACKING"
  mkfs.btrfs -f -L sezu-btrfs-backing "$SEZU_STORAGE_BACKING" >/dev/null
else
  [[ -f $SEZU_STORAGE_BACKING ]] || { echo "storage backing path is not a regular file" >&2; exit 1; }
  [[ $(stat -c %s "$SEZU_STORAGE_BACKING") -eq $SEZU_STORAGE_SIZE_BYTES ]] || { echo "storage backing size is incorrect" >&2; exit 1; }
  [[ $(blkid -p -s TYPE -o value "$SEZU_STORAGE_BACKING" 2>/dev/null || true) == btrfs ]] || { echo "storage backing is not Btrfs" >&2; exit 1; }
fi

update-initramfs -u -k "$SEZU_REQUIRED_KERNEL"
root_uuid=$(findmnt -no UUID /)
grub_target="gnulinux-advanced-${root_uuid}>gnulinux-${SEZU_REQUIRED_KERNEL}-advanced-${root_uuid}"
python3 - "$grub_target" <<'PY'
from pathlib import Path
import sys
path = Path("/etc/default/grub")
target = sys.argv[1]
lines = path.read_text(encoding="utf-8").splitlines()
replacement = f'GRUB_DEFAULT="{target}"'
for index, line in enumerate(lines):
    if line.startswith("GRUB_DEFAULT="):
        lines[index] = replacement
        break
else:
    lines.append(replacement)
path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
update-grub >/dev/null
grep -Fq "$grub_target" /boot/grub/grub.cfg
[[ -s /boot/vmlinuz-$SEZU_REQUIRED_KERNEL && -s /boot/initrd.img-$SEZU_REQUIRED_KERNEL ]]

systemctl daemon-reload
if [[ $(uname -r) == "$SEZU_REQUIRED_KERNEL" ]]; then
  systemctl start dev-zram0.swap
fi
systemctl start incus.service
systemctl is-active --quiet incus.service
incus version >/dev/null
systemctl is-enabled --quiet baby-quirt-mcp.service
systemctl is-active --quiet baby-quirt-mcp.service
systemctl is-enabled --quiet sezu-initialization-baby-guard.timer
systemctl is-active --quiet sezu-initialization-baby-guard.timer

rm -rf "$STAGE"
if [[ $(uname -r) == "$SEZU_REQUIRED_KERNEL" ]]; then
  echo "Phase 1 host state applied."
else
  echo "Phase 1 host state applied; reboot into $SEZU_REQUIRED_KERNEL is required."
fi
