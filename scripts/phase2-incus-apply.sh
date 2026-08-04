#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source "$ROOT/config/host/phase1.conf"
source "$ROOT/config/incus/phase2.conf"

if [[ $EUID -ne 0 ]]; then
  echo "phase2-incus-apply.sh must run as root" >&2
  exit 1
fi

require_value() {
  local actual=$1 expected=$2 label=$3
  [[ $actual == "$expected" ]] || { echo "$label: expected $expected, got ${actual:-<empty>}" >&2; exit 1; }
}

ipv6_outbound() {
  ping -6 -c 1 -W 4 2606:4700:4700::1111 >/dev/null 2>&1 ||
    curl -6 -fsS --connect-timeout 12 --max-time 20 --resolve 'one.one.one.one:443:[2606:4700:4700::1111]' https://one.one.one.one/cdn-cgi/trace >/dev/null
}

ensure_project_feature() {
  local key=$1
  incus project set "$SEZU_INCUS_PROJECT" "$key=true"
}

ensure_network_key() {
  local key=$1 value=$2
  incus network set "$SEZU_INCUS_NETWORK" "$key=$value"
}

ensure_profile_key() {
  local key=$1 value=$2
  incus profile set "$SEZU_INCUS_PROFILE" "$key=$value" --project "$SEZU_INCUS_PROJECT"
}

ensure_profile_device() {
  local name=$1 type=$2
  shift 2
  if incus profile device show "$SEZU_INCUS_PROFILE" --project "$SEZU_INCUS_PROJECT" | grep -q "^${name}:"; then
    incus profile device set "$SEZU_INCUS_PROFILE" "$name" "$@" --project "$SEZU_INCUS_PROJECT"
  else
    incus profile device add "$SEZU_INCUS_PROFILE" "$name" "$type" "$@" --project "$SEZU_INCUS_PROJECT"
  fi
}

. /etc/os-release
require_value "${ID:-}" ubuntu "host OS"
require_value "${VERSION_ID:-}" 24.04 "host release"
require_value "$(dpkg --print-architecture)" amd64 "host architecture"
require_value "$(uname -r)" "$SEZU_REQUIRED_KERNEL" "running kernel"
require_value "$(incus version | sed -n 's/^Client version: //p')" 6.0.6 "Incus client"
for package in incus incus-base incus-client; do
  require_value "$(dpkg-query -W -f='${Version}' "$package")" "$SEZU_INCUS_PACKAGE_VERSION" "$package version"
done
[[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm ]]
[[ -f $SEZU_STORAGE_BACKING ]]
require_value "$(stat -c %s "$SEZU_STORAGE_BACKING")" "$SEZU_STORAGE_SIZE_BYTES" "storage backing size"
require_value "$(blkid -p -s TYPE -o value "$SEZU_STORAGE_BACKING")" btrfs "storage backing filesystem"
require_value "$(stat -c %U:%G "$SEZU_STORAGE_BACKING")" root:root "storage backing owner"
chmod 0600 "$SEZU_STORAGE_BACKING"

ip -4 address show dev "$SEZU_HOST_INTERFACE" | grep -Fq "inet $SEZU_HOST_IPV4/32"
ip -4 route show default | grep -Eq "^default via ${SEZU_HOST_IPV4_GATEWAY//./\\.} dev $SEZU_HOST_INTERFACE"
install -D -m 0600 "$ROOT/config/network/60-sezu-ipv6.yaml" /etc/netplan/60-sezu-ipv6.yaml
install -D -m 0644 "$ROOT/config/network/91-sezu-network.conf" /etc/sysctl.d/91-sezu-network.conf
netplan generate
sysctl --system >/dev/null
netplan apply
udevadm settle
sleep 2
ip -4 address show dev "$SEZU_HOST_INTERFACE" | grep -Fq "inet $SEZU_HOST_IPV4/32"
ip -4 route show default | grep -Eq "^default via ${SEZU_HOST_IPV4_GATEWAY//./\\.} dev $SEZU_HOST_INTERFACE"
ip -6 address show dev "$SEZU_HOST_INTERFACE" | grep -Fq "inet6 $SEZU_HOST_IPV6"
ip -6 route show default | grep -Eq "^default via ${SEZU_HOST_IPV6_GATEWAY//:/\\:} dev $SEZU_HOST_INTERFACE .*onlink"
require_value "$(sysctl -n net.ipv4.ip_forward)" 1 "IPv4 forwarding"
require_value "$(sysctl -n net.ipv6.conf.all.forwarding)" 1 "IPv6 forwarding"
require_value "$(sysctl -n net.ipv6.conf.default.forwarding)" 1 "default IPv6 forwarding"
curl -4 -fsS --connect-timeout 10 --max-time 20 https://api.ipify.org | grep -Fxq "$SEZU_HOST_IPV4"
ipv6_outbound
getent ahosts github.com >/dev/null
systemctl is-active --quiet baby-quirt.socket
systemctl is-active --quiet baby-quirt-mcp.service
systemctl is-active --quiet sezu-initialization-baby-guard.timer

systemctl start incus.service
systemctl is-active --quiet incus.service
[[ -z $(incus config get core.https_address) ]] || incus config unset core.https_address
if ! incus project show "$SEZU_INCUS_PROJECT" >/dev/null 2>&1; then
  incus project create "$SEZU_INCUS_PROJECT" --description "SEZU resources"
fi
for key in features.images features.networks.zones features.profiles features.storage.buckets features.storage.volumes; do
  ensure_project_feature "$key"
done
# Incus 6.0.6 supports project-local networks only for OVN. The canonical
# Linux bridge stays global and is shared by the unrestricted sezu project.
incus project set "$SEZU_INCUS_PROJECT" features.networks=false
while IFS= read -r key; do
  [[ -n $key ]] && incus project unset "$SEZU_INCUS_PROJECT" "$key"
done < <(incus query "/1.0/projects/$SEZU_INCUS_PROJECT" | python3 -c 'import json,sys; c=json.load(sys.stdin).get("config",{}); print("\n".join(k for k,v in c.items() if k.startswith("limits.") or (k.startswith("restricted") and v not in ("", "false"))))')

install -d -m 0711 "$(dirname "$SEZU_INCUS_LOOP_SOURCE")"
if [[ -L $SEZU_INCUS_LOOP_SOURCE ]]; then
  require_value "$(readlink -f "$SEZU_INCUS_LOOP_SOURCE")" "$SEZU_INCUS_POOL_SOURCE" "Incus loop source target"
elif [[ -e $SEZU_INCUS_LOOP_SOURCE ]]; then
  echo "Incus loop source exists and is not the canonical symlink: $SEZU_INCUS_LOOP_SOURCE" >&2
  exit 1
else
  ln -s "$SEZU_INCUS_POOL_SOURCE" "$SEZU_INCUS_LOOP_SOURCE"
fi
if ! incus storage show "$SEZU_INCUS_POOL" >/dev/null 2>&1; then
  printf 'yes\n%s\nbtrfs\n%s\nsize=%s\n\nno\nyes\nyes\n' \
    "$SEZU_INCUS_POOL" "$SEZU_INCUS_LOOP_SOURCE" "$SEZU_STORAGE_SIZE_BYTES" | timeout 90s incus admin recover
fi
incus storage set "$SEZU_INCUS_POOL" "size=$SEZU_STORAGE_SIZE_BYTES"
pool_json=$(incus query "/1.0/storage-pools/$SEZU_INCUS_POOL")
require_value "$(python3 -c 'import json,sys; print(json.load(sys.stdin)["driver"])' <<<"$pool_json")" btrfs "storage driver"
require_value "$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("config",{}).get("source",""))' <<<"$pool_json")" "$SEZU_INCUS_LOOP_SOURCE" "storage source"
require_value "$(readlink -f "$SEZU_INCUS_LOOP_SOURCE")" "$SEZU_INCUS_POOL_SOURCE" "storage source resolution"
require_value "$(stat -c %s "$SEZU_STORAGE_BACKING")" "$SEZU_STORAGE_SIZE_BYTES" "storage backing size after pool recovery"
require_value "$(blkid -p -s TYPE -o value "$SEZU_STORAGE_BACKING")" btrfs "storage backing after pool recovery"
findmnt -T "/var/lib/incus/storage-pools/$SEZU_INCUS_POOL" -n -o FSTYPE | grep -Fxq btrfs

if ! incus network show "$SEZU_INCUS_NETWORK" >/dev/null 2>&1; then
  incus network create "$SEZU_INCUS_NETWORK" --type=bridge \
    "ipv4.address=$SEZU_INCUS_IPV4" ipv4.nat=true ipv4.dhcp=true \
    "ipv6.address=$SEZU_INCUS_IPV6" ipv6.nat=true ipv6.dhcp=true ipv6.dhcp.stateful=false \
    dns.mode=managed
fi
ensure_network_key ipv4.address "$SEZU_INCUS_IPV4"
ensure_network_key ipv4.nat true
ensure_network_key ipv4.dhcp true
ensure_network_key ipv6.address "$SEZU_INCUS_IPV6"
ensure_network_key ipv6.nat true
ensure_network_key ipv6.dhcp true
ensure_network_key ipv6.dhcp.stateful false
ensure_network_key dns.mode managed

for volume in "$SEZU_WORK_VOLUME" "$SEZU_CACHE_VOLUME"; do
  if ! incus storage volume show "$SEZU_INCUS_POOL" "$volume" --project "$SEZU_INCUS_PROJECT" >/dev/null 2>&1; then
    incus storage volume create "$SEZU_INCUS_POOL" "$volume" --project "$SEZU_INCUS_PROJECT"
  fi
done
if ! incus profile show "$SEZU_INCUS_PROFILE" --project "$SEZU_INCUS_PROJECT" >/dev/null 2>&1; then
  incus profile create "$SEZU_INCUS_PROFILE" --project "$SEZU_INCUS_PROJECT"
fi
ensure_profile_key security.privileged true
ensure_profile_key security.nesting true
ensure_profile_key security.syscalls.intercept.mknod true
ensure_profile_key security.syscalls.intercept.setxattr true
while IFS= read -r key; do
  [[ -n $key ]] && incus profile unset "$SEZU_INCUS_PROFILE" "$key" --project "$SEZU_INCUS_PROJECT"
done < <(incus query "/1.0/profiles/$SEZU_INCUS_PROFILE?project=$SEZU_INCUS_PROJECT" | python3 -c 'import json,sys; c=json.load(sys.stdin).get("config",{}); print("\n".join(k for k in c if k.startswith("limits.") or k in ("boot.autostart","boot.autostart.delay","boot.autostart.priority")))')
ensure_profile_device root disk path=/ "pool=$SEZU_INCUS_POOL"
ensure_profile_device eth0 nic "network=$SEZU_INCUS_NETWORK" name=eth0
ensure_profile_device work disk "pool=$SEZU_INCUS_POOL" "source=$SEZU_WORK_VOLUME" path=/work
ensure_profile_device cache disk "pool=$SEZU_INCUS_POOL" "source=$SEZU_CACHE_VOLUME" path=/cache
for spec in \
  'kvm:/dev/kvm' \
  'tun:/dev/net/tun' \
  'fuse:/dev/fuse' \
  'vhost-net:/dev/vhost-net' \
  'vhost-vsock:/dev/vhost-vsock'; do
  name=${spec%%:*}
  path=${spec#*:}
  [[ -c $path ]] || continue
  ensure_profile_device "$name" unix-char "source=$path" "path=$path"
done

for path in /1.0 /1.0/projects /1.0/profiles /1.0/storage-pools /1.0/networks /1.0/images /1.0/instances /1.0/certificates /1.0/operations; do
  case $path in
    /1.0|/1.0/projects|/1.0/storage-pools|/1.0/networks|/1.0/certificates) incus query "$path" >/dev/null ;;
    *) incus query "$path?project=$SEZU_INCUS_PROJECT" >/dev/null ;;
  esac
done

"$ROOT/scripts/phase2-incus-check.sh"
echo "Phase 2 networking and Incus state applied."
