#!/usr/bin/env bash
set -u

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source "$ROOT/config/host/phase1.conf"
failures=0

pass() { printf 'ok: %s\n' "$1"; }
fail() { printf 'not ready: %s\n' "$1" >&2; failures=$((failures + 1)); }
. /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]] && pass "Ubuntu 24.04" || fail "Ubuntu 24.04"
[[ $(dpkg --print-architecture) == amd64 ]] && pass "amd64" || fail "amd64"
[[ $(uname -r) == "$SEZU_REQUIRED_KERNEL" ]] && pass "running kernel $SEZU_REQUIRED_KERNEL" || fail "running kernel $SEZU_REQUIRED_KERNEL"

python3 "$ROOT/scripts/validate-locks.py" >/dev/null && pass "release locks" || fail "release locks"
if python3 - "$ROOT/locks/apt-host.tsv" <<'PY'
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
bad = [row for row in rows if installed.get(row["package"]) != row["version"]]
raise SystemExit(1 if bad else 0)
PY
then pass "271 locked host packages"; else fail "271 locked host packages"; fi

for package in "linux-image-$SEZU_REQUIRED_KERNEL" "linux-modules-$SEZU_REQUIRED_KERNEL" "linux-modules-extra-$SEZU_REQUIRED_KERNEL"; do
  dpkg-query -W -f='${Status}\n' "$package" 2>/dev/null | grep -qx 'install ok installed' && pass "$package" || fail "$package"
done
root_uuid=$(findmnt -no UUID /)
grub_target="gnulinux-advanced-${root_uuid}>gnulinux-${SEZU_REQUIRED_KERNEL}-advanced-${root_uuid}"
grep -Fq "GRUB_DEFAULT=\"$grub_target\"" /etc/default/grub && grep -Fq "$grub_target" /boot/grub/grub.cfg && pass "GRUB default" || fail "GRUB default"

incus_ok=1
for package in incus incus-base incus-client; do
  version=$(dpkg-query -W -f='${Version}' "$package" 2>/dev/null || true)
  [[ $version == "$SEZU_INCUS_PACKAGE_VERSION" ]] || incus_ok=0
done
[[ $incus_ok -eq 1 ]] && incus version >/dev/null 2>&1 && systemctl is-active --quiet incus.service && pass "Incus 6.0.6 packages and daemon" || fail "Incus 6.0.6 packages and daemon"

if grep -qm1 -w vmx /proc/cpuinfo && [[ -c /dev/kvm ]] && [[ -r /dev/kvm && -w /dev/kvm ]] && [[ -d /sys/module/kvm_intel ]]; then
  pass "Intel KVM"
else
  fail "Intel KVM"
fi

modules=(kvm kvm_intel vhost vhost_net vhost_vsock tun fuse loop btrfs overlay bridge br_netfilter nf_conntrack nf_nat zram)
for module in "${modules[@]}"; do
  module_name=${module//-/_}
  module_file=$(modinfo -F filename "$module" 2>/dev/null || true)
  if [[ -d /sys/module/$module_name || $module_file == "(builtin)" ]]; then
    continue
  fi
  fail "kernel module $module"
done
if cmp -s "$ROOT/systemd/modules-load/sezu.conf" /etc/modules-load.d/sezu.conf; then
  pass "persistent module configuration"
else
  fail "persistent module configuration"
fi

sysctl_at_least() {
  local key=$1 expected=$2 actual
  actual=$(sysctl -n "$key" 2>/dev/null) || return 1
  [[ $actual =~ ^[0-9]+$ && $actual -ge $expected ]]
}
sysctl_at_least fs.inotify.max_user_instances 8192 && \
sysctl_at_least fs.inotify.max_user_watches 1048576 && \
sysctl_at_least vm.max_map_count 1048576 && \
sysctl_at_least user.max_user_namespaces 1048576 && \
[[ $(sysctl -n kernel.unprivileged_userns_clone) == 1 ]] && \
[[ $(sysctl -n net.ipv4.ip_forward) == 1 ]] && \
[[ $(sysctl -n net.bridge.bridge-nf-call-iptables) == 1 ]] && \
[[ $(sysctl -n net.bridge.bridge-nf-call-ip6tables) == 1 ]] && pass "host sysctl settings" || fail "host sysctl settings"
persistent_config=1
cmp -s "$ROOT/systemd/sysctl/sezu.conf" /etc/sysctl.d/90-sezu.conf || persistent_config=0
cmp -s "$ROOT/config/host/limits.conf" /etc/security/limits.d/90-sezu.conf || persistent_config=0
cmp -s "$ROOT/systemd/tmpfiles/sezu.conf" /etc/tmpfiles.d/sezu.conf || persistent_config=0
cmp -s "$ROOT/systemd/zram-generator.conf" /etc/systemd/zram-generator.conf || persistent_config=0
[[ $persistent_config -eq 1 ]] && pass "persistent host configuration" || fail "persistent host configuration"

zram_line=$(swapon --show=NAME,SIZE --noheadings --bytes --raw 2>/dev/null | awk '$1=="/dev/zram0" {print $0}')
[[ -n $zram_line && -f /etc/systemd/zram-generator.conf ]] && pass "zram swap $zram_line" || fail "zram swap"

[[ -f $SEZU_STORAGE_BACKING ]] && \
[[ $(stat -c %s "$SEZU_STORAGE_BACKING" 2>/dev/null) -eq $SEZU_STORAGE_SIZE_BYTES ]] && \
[[ $(blkid -p -s TYPE -o value "$SEZU_STORAGE_BACKING" 2>/dev/null) == btrfs ]] && \
! findmnt -rn -S "$SEZU_STORAGE_BACKING" >/dev/null 2>&1 && pass "unmounted Btrfs storage backing" || fail "unmounted Btrfs storage backing"

getent group sezu >/dev/null && getent passwd sezu-tunnel >/dev/null && id -nG sezu-tunnel | tr ' ' '\n' | grep -qx sezu && pass "SEZU identities" || fail "SEZU identities"

directories=(
  /opt/sezu/releases /opt/sezu/toolchains /opt/sezu/packs /opt/sezu/skills
  /etc/sezu /etc/sezu/credentials /etc/sezu/skills
  /var/lib/sezu/jobs /var/lib/sezu/terminals /var/lib/sezu/artifacts /var/lib/sezu/workspaces
  /var/lib/sezu/browser-profiles /var/lib/sezu/packs /var/lib/sezu/templates /var/lib/sezu/timers /var/lib/sezu/storage
  /var/cache/sezu/sources /run/sezu /var/log/sezu
)
dirs_ok=1
for directory in "${directories[@]}"; do [[ -d $directory ]] || dirs_ok=0; done
[[ $dirs_ok -eq 1 ]] && [[ $(stat -c '%U:%G:%a' /run/sezu) == root:sezu:750 ]] && pass "SEZU host directories" || fail "SEZU host directories"

systemctl is-active --quiet baby-quirt-mcp.service && systemctl is-enabled --quiet baby-quirt-mcp.service && pass "Baby construction path" || fail "Baby construction path"
systemctl is-active --quiet sezu-initialization-baby-guard.timer && systemctl is-enabled --quiet sezu-initialization-baby-guard.timer && pass "preexisting Baby guard" || fail "preexisting Baby guard"

if systemctl cat sezu-supervisor.service >/dev/null 2>&1 || systemctl cat sezu-tunnel.service >/dev/null 2>&1; then
  fail "later SEZU services are absent"
else
  pass "later SEZU services are absent"
fi

if ip link show sezu-br0 >/dev/null 2>&1; then fail "host bridge sezu-br0 is absent"; else pass "host bridge sezu-br0 is absent"; fi
if incus network list --format csv -c n 2>/dev/null | grep -qx sezu-br0; then fail "Incus network sezu-br0 is absent"; else pass "Incus network sezu-br0 is absent"; fi
if incus project list --format csv 2>/dev/null | cut -d, -f1 | grep -qx sezu; then fail "Incus project sezu is absent"; else pass "Incus project sezu is absent"; fi
if incus storage list --format csv -c n 2>/dev/null | grep -qx sezu-btrfs; then fail "Incus pool sezu-btrfs is absent"; else pass "Incus pool sezu-btrfs is absent"; fi
if incus profile list --format csv 2>/dev/null | cut -d, -f1 | grep -qx sezu-u-power; then fail "Incus profile sezu-u-power is absent"; else pass "Incus profile sezu-u-power is absent"; fi
if incus list --format csv -c n 2>/dev/null | grep -Eq '^(u|u-build)$'; then fail "u and u-build are absent"; else pass "u and u-build are absent"; fi
if incus image list --format csv -c f 2>/dev/null | grep -q .; then fail "Incus images are absent"; else pass "Incus images are absent"; fi
ip -4 -o addr show dev ens3 | grep -q '51\.81\.86\.225/32' && pass "public IPv4 unchanged" || fail "public IPv4 unchanged"
if ip -6 -o addr show dev ens3 scope global | grep -q .; then fail "SEZU host IPv6 is not configured"; else pass "SEZU host IPv6 is not configured"; fi

dpkg --audit | grep -q . && fail "dpkg configuration" || pass "dpkg configuration"
apt-get check >/dev/null 2>&1 && pass "APT dependencies" || fail "APT dependencies"
if systemctl --failed --no-legend --plain | awk '{print $1}' | grep -Eq '^(incus|dev-zram0|systemd-zram|sezu-supervisor|sezu-tunnel)'; then
  fail "Phase 1 systemd units"
else
  pass "Phase 1 systemd units"
fi

if ((failures)); then
  printf 'Phase 1 host check failed: %d requirement(s) unmet\n' "$failures" >&2
  exit 1
fi
printf 'Phase 1 host ready\n'
