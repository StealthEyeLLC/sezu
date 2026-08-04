#!/usr/bin/env bash
set -uo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
source "$ROOT/config/host/phase1.conf"
source "$ROOT/config/incus/phase2.conf"
failures=0

pass() { printf 'ok: %s\n' "$1"; }
fail() { printf 'not ready: %s\n' "$1" >&2; failures=$((failures + 1)); }
check() { local label=$1; shift; if "$@"; then pass "$label"; else fail "$label"; fi; }
json_value() { local expression=$1; python3 -c "import json,sys; d=json.load(sys.stdin); print($expression)"; }
ipv6_outbound() {
  ping -6 -c 1 -W 4 2606:4700:4700::1111 >/dev/null 2>&1 ||
    curl -6 -fsS --connect-timeout 12 --max-time 20 --resolve 'one.one.one.one:443:[2606:4700:4700::1111]' https://one.one.one.one/cdn-cgi/trace >/dev/null
}

. /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_ID:-} == 24.04 ]] && pass "Ubuntu 24.04" || fail "Ubuntu 24.04"
[[ $(dpkg --print-architecture) == amd64 ]] && pass amd64 || fail amd64
[[ $(uname -r) == "$SEZU_REQUIRED_KERNEL" ]] && pass "kernel $SEZU_REQUIRED_KERNEL" || fail "kernel $SEZU_REQUIRED_KERNEL"
incus_version=$(incus version 2>/dev/null | sed -n 's/^Client version: //p' || true)
[[ $incus_version == 6.0.6 ]] && pass "Incus 6.0.6" || fail "Incus 6.0.6"
packages_ok=1
for package in incus incus-base incus-client; do
  [[ $(dpkg-query -W -f='${Version}' "$package" 2>/dev/null || true) == "$SEZU_INCUS_PACKAGE_VERSION" ]] || packages_ok=0
done
[[ $packages_ok -eq 1 ]] && pass "locked Incus packages" || fail "locked Incus packages"
[[ -b /dev/zram0 ]] && swapon --show=NAME --noheadings | grep -Fxq /dev/zram0 && pass "active zram" || fail "active zram"
[[ -c /dev/kvm && -r /dev/kvm && -w /dev/kvm && -d /sys/module/kvm_intel ]] && pass "Intel KVM" || fail "Intel KVM"
getent group sezu >/dev/null && id sezu-tunnel >/dev/null 2>&1 && pass "SEZU identities" || fail "SEZU identities"
for directory in /opt/sezu /etc/sezu /var/lib/sezu /var/cache/sezu /run/sezu /var/log/sezu; do [[ -d $directory ]] || fail "directory $directory"; done
systemctl is-active --quiet incus.service && pass "Incus daemon" || fail "Incus daemon"
systemctl is-active --quiet baby-quirt.socket && systemctl is-active --quiet baby-quirt-mcp.service && pass "Baby lifeline" || fail "Baby lifeline"
systemctl is-enabled --quiet sezu-initialization-baby-guard.timer && systemctl is-active --quiet sezu-initialization-baby-guard.timer && pass "initialization guard" || fail "initialization guard"
[[ -z $(systemctl --failed --no-legend --plain 2>/dev/null) ]] && pass "no failed systemd units" || fail "no failed systemd units"

ip -4 address show dev "$SEZU_HOST_INTERFACE" | grep -Fq "inet $SEZU_HOST_IPV4/32" && pass "host IPv4 $SEZU_HOST_IPV4" || fail "host IPv4 $SEZU_HOST_IPV4"
ip -4 route show default | grep -Eq "^default via ${SEZU_HOST_IPV4_GATEWAY//./\\.} dev $SEZU_HOST_INTERFACE" && pass "IPv4 default route" || fail "IPv4 default route"
ip -6 address show dev "$SEZU_HOST_INTERFACE" | grep -Fq "inet6 $SEZU_HOST_IPV6" && pass "host IPv6 $SEZU_HOST_IPV6" || fail "host IPv6 $SEZU_HOST_IPV6"
ip -6 route show default | grep -Eq "^default via ${SEZU_HOST_IPV6_GATEWAY//:/\\:} dev $SEZU_HOST_INTERFACE .*onlink" && pass "IPv6 on-link gateway" || fail "IPv6 on-link gateway"
[[ $(sysctl -n net.ipv4.ip_forward 2>/dev/null) == 1 && $(sysctl -n net.ipv6.conf.all.forwarding 2>/dev/null) == 1 && $(sysctl -n net.ipv6.conf.default.forwarding 2>/dev/null) == 1 ]] && pass "Incus forwarding" || fail "Incus forwarding"
curl -4 -fsS --connect-timeout 10 --max-time 20 https://api.ipify.org 2>/dev/null | grep -Fxq "$SEZU_HOST_IPV4" && pass "outbound IPv4" || fail "outbound IPv4"
ipv6_outbound && pass "outbound IPv6" || fail "outbound IPv6"
getent ahosts github.com >/dev/null && pass "host DNS" || fail "host DNS"

[[ -z $(incus config get core.https_address 2>/dev/null) ]] && pass "local-only Incus API" || fail "local-only Incus API"
project_json=$(incus query "/1.0/projects/$SEZU_INCUS_PROJECT" 2>/dev/null || true)
if [[ -n $project_json ]]; then
  if PROJECT_JSON="$project_json" python3 - <<'PY'
import json, os, sys
p=json.loads(os.environ['PROJECT_JSON'])
c=p.get('config', {})
required=('features.images','features.networks.zones','features.profiles','features.storage.buckets','features.storage.volumes')
assert all(c.get(k)=='true' for k in required)
assert c.get('features.networks')=='false'
assert not any(k.startswith('limits.') for k in c)
assert c.get('restricted') not in ('true','1')
PY
  then pass "sezu project features and shared bridge mode without quotas"; else fail "sezu project features and shared bridge mode without quotas"; fi
else fail "sezu project"; fi

pool_json=$(incus query "/1.0/storage-pools/$SEZU_INCUS_POOL" 2>/dev/null || true)
if [[ -n $pool_json ]]; then
  driver=$(json_value 'd.get("driver","")' <<<"$pool_json")
  source_path=$(json_value 'd.get("config",{}).get("source","")' <<<"$pool_json")
  [[ $driver == btrfs && $source_path == "$SEZU_INCUS_LOOP_SOURCE" && $(readlink -f "$SEZU_INCUS_LOOP_SOURCE" 2>/dev/null) == "$SEZU_INCUS_POOL_SOURCE" ]] && pass "Btrfs pool source" || fail "Btrfs pool source"
  incus storage info "$SEZU_INCUS_POOL" >/dev/null 2>&1 && findmnt -T "/var/lib/incus/storage-pools/$SEZU_INCUS_POOL" -n -o FSTYPE 2>/dev/null | grep -Fxq btrfs && pass "usable storage pool" || fail "usable storage pool"
else fail "storage pool $SEZU_INCUS_POOL"; fi
[[ -f $SEZU_STORAGE_BACKING && $(stat -c %s "$SEZU_STORAGE_BACKING" 2>/dev/null) == "$SEZU_STORAGE_SIZE_BYTES" && $(blkid -p -s TYPE -o value "$SEZU_STORAGE_BACKING" 2>/dev/null) == btrfs ]] && pass "original 40 GiB Btrfs backing" || fail "original 40 GiB Btrfs backing"
for volume in "$SEZU_WORK_VOLUME" "$SEZU_CACHE_VOLUME"; do
  incus storage volume show "$SEZU_INCUS_POOL" "$volume" --project "$SEZU_INCUS_PROJECT" >/dev/null 2>&1 && pass "volume $volume" || fail "volume $volume"
done

network_json=$(incus query "/1.0/networks/$SEZU_INCUS_NETWORK" 2>/dev/null || true)
if [[ -n $network_json ]]; then
  if NETWORK_JSON="$network_json" python3 - <<'PY'
import json, os
n=json.loads(os.environ['NETWORK_JSON'])
c=n.get('config', {})
assert n.get('type') == 'bridge'
assert n.get('managed') is True
assert c.get('ipv4.address') == '10.177.0.1/24'
assert c.get('ipv4.nat') == 'true'
assert c.get('ipv6.address') == 'fd42:7365:7a75::1/64'
assert c.get('ipv6.nat') == 'true'
PY
  then pass "managed bridge addresses and NAT"; else fail "managed bridge addresses and NAT"; fi
else fail "managed bridge $SEZU_INCUS_NETWORK"; fi
[[ -d /sys/class/net/$SEZU_INCUS_NETWORK ]] && pass "bridge host link" || fail "bridge host link"
[[ ! -e /sys/class/net/$SEZU_HOST_INTERFACE/master ]] && pass "ens3 remains outside bridge" || fail "ens3 remains outside bridge"
forward_count=$(incus query "/1.0/networks/$SEZU_INCUS_NETWORK/forwards" 2>/dev/null | python3 -c 'import json,sys; print(len(json.load(sys.stdin)))' 2>/dev/null || echo 1)
[[ $forward_count == 0 ]] && pass "no inbound network forwards" || fail "no inbound network forwards"
if nft list ruleset 2>/dev/null | grep -F "$SEZU_INCUS_IPV4_SUBNET" | grep -q masquerade && nft list ruleset 2>/dev/null | grep -F "$SEZU_INCUS_IPV6_SUBNET" | grep -q masquerade; then pass "Incus IPv4 and IPv6 masquerade rules"; else fail "Incus IPv4 and IPv6 masquerade rules"; fi

profile_json=$(incus query "/1.0/profiles/$SEZU_INCUS_PROFILE?project=$SEZU_INCUS_PROJECT" 2>/dev/null || true)
if [[ -n $profile_json ]]; then
  if PROFILE_JSON="$profile_json" python3 - <<'PY'
import json, os
p=json.loads(os.environ['PROFILE_JSON'])
c=p.get('config', {})
d=p.get('devices', {})
assert c.get('security.privileged') == 'true'
assert c.get('security.nesting') == 'true'
assert c.get('security.syscalls.intercept.mknod') == 'true'
assert c.get('security.syscalls.intercept.setxattr') == 'true'
assert not any(k.startswith('limits.') for k in c)
assert not any(k.startswith('boot.autostart') for k in c)
assert d.get('root') == {'type':'disk','path':'/','pool':'sezu-btrfs'}
assert d.get('eth0') == {'type':'nic','network':'sezu-br0','name':'eth0'}
assert d.get('work') == {'type':'disk','pool':'sezu-btrfs','source':'u-work','path':'/work'}
assert d.get('cache') == {'type':'disk','pool':'sezu-btrfs','source':'u-cache','path':'/cache'}
for name,path in [('kvm','/dev/kvm'),('tun','/dev/net/tun'),('fuse','/dev/fuse'),('vhost-net','/dev/vhost-net'),('vhost-vsock','/dev/vhost-vsock')]:
    if os.path.exists(path):
        assert d.get(name) == {'type':'unix-char','source':path,'path':path}
PY
  then pass "primary profile configuration and devices"; else fail "primary profile configuration and devices"; fi
else fail "profile $SEZU_INCUS_PROFILE"; fi

if incus query /1.0 | python3 -c 'import json,sys; e=set(json.load(sys.stdin).get("api_extensions",[])); required={"projects","projects_networks","projects_networks_zones","network_acl","storage_buckets","custom_volume_backup","virtual-machines","instances","container_backup","migration_progress"}; raise SystemExit(0 if required <= e else 1)' 2>/dev/null; then pass "required Incus extensions including VM support"; else fail "required Incus extensions including VM support"; fi
api_ok=1
for path in /1.0 /1.0/projects /1.0/profiles /1.0/storage-pools /1.0/networks /1.0/images /1.0/instances /1.0/certificates /1.0/operations; do
  case $path in
    /1.0|/1.0/projects|/1.0/storage-pools|/1.0/networks|/1.0/certificates) incus query "$path" >/dev/null 2>&1 || api_ok=0 ;;
    *) incus query "$path?project=$SEZU_INCUS_PROJECT" >/dev/null 2>&1 || api_ok=0 ;;
  esac
done
incus remote list --format csv >/dev/null 2>&1 || api_ok=0
[[ $api_ok -eq 1 ]] && pass "local Incus API and CLI families" || fail "local Incus API and CLI families"

if python3 - "$ROOT" <<'PY'
import json, pathlib, sys
root=pathlib.Path(sys.argv[1])
lock=json.loads((root/'locks/service-images.json').read_text())['services']
by_id={x['template_id']:x for x in lock}
files=sorted((root/'templates/services').glob('service-*.json'))
assert len(files)==17 and len(by_id)==17
for path in files:
    t=json.loads(path.read_text())
    x=by_id[t['template_id']]
    assert t['image_lock']==f"locks/service-images.json#{t['template_id']}"
    assert t['immutable_reference']==x['immutable_reference']
    assert t['instance_type']==x['instance_type']
    assert t['command']==x['command']
    assert t['ports']==x['ports']
    assert t['persistent_mounts']==x['persistent_mounts']
    assert t['required_environment']==x['required_environment']
    assert '@sha256:' in t['immutable_reference']
assert set(by_id)=={json.loads(p.read_text())['template_id'] for p in files}
task=json.loads((root/'templates/tasks/task-default.json').read_text())
assert task['template_id']=='task-default' and task['instance_type'] in ('container','virtual-machine')
assert task['project']=='sezu' and task['network']=='sezu-br0' and task['storage_pool']=='sezu-btrfs'
assert task['lifecycle']['delete_requested'] is False and task['lifecycle']['delete_attached_volumes'] is False
vm=json.loads((root/'templates/vms/vm-default.json').read_text())
assert vm['template_id']=='vm-default' and vm['instance_type']=='virtual-machine'
assert vm['project']=='sezu' and vm['root_storage_pool']=='sezu-btrfs' and vm['network']=='sezu-br0'
assert vm['profiles']==[] and vm['start'] is False and vm['source']['exact_reference_required'] is True
PY
then pass "task, 17 service, and VM templates"; else fail "task, 17 service, and VM templates"; fi
python3 "$ROOT/scripts/validate-locks.py" >/dev/null 2>&1 && pass "release locks" || fail "release locks"

instances=$(incus list --project "$SEZU_INCUS_PROJECT" --format csv -c n 2>/dev/null || echo query-failed)
[[ -z $instances ]] && pass "no SEZU instances" || fail "no SEZU instances"
for name in "$SEZU_FUTURE_BUILD_INSTANCE" "$SEZU_FUTURE_PRODUCTION_INSTANCE"; do
  incus info "$name" --project "$SEZU_INCUS_PROJECT" >/dev/null 2>&1 && fail "$name absent" || pass "$name absent"
done
incus image alias show "$SEZU_FUTURE_GOLDEN_ALIAS" --project "$SEZU_INCUS_PROJECT" >/dev/null 2>&1 && fail "golden image absent" || pass "golden image absent"
if systemctl is-active --quiet sezu-supervisor.service 2>/dev/null || systemctl is-active --quiet sezu-tunnel.service 2>/dev/null; then fail "SEZU runtime not started"; else pass "SEZU runtime not started"; fi

if (( failures )); then
  printf 'Phase 2 check failed: %d requirement(s) unmet.\n' "$failures" >&2
  exit 1
fi
printf 'Phase 2 direct checks passed.\n'
