#!/usr/bin/env bash
set -euo pipefail
PROJECT=sezu
POOL=sezu-btrfs
BRIDGE=sezu-br0
PROFILE=sezu-u-power
ALIAS=sezu-u-golden-0.1.0
REPO=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO"
pass() { printf 'ok %s\n' "$1"; }

systemctl is-active --quiet baby-quirt.socket
systemctl is-active --quiet baby-quirt-mcp.service
systemctl is-active --quiet sezu-initialization-baby-guard.timer
pass baby

incus version | awk '$1=="Client" && $2=="version:" && $3=="6.0.6" {ok=1} END {exit !ok}'
incus project show "$PROJECT" >/dev/null
storage_show=$(incus storage show "$POOL" --project "$PROJECT")
grep -Fx 'driver: btrfs' <<<"$storage_show" >/dev/null
network_show=$(incus network show "$BRIDGE" --project "$PROJECT")
grep -F 'ipv4.address: 10.177.0.1/24' <<<"$network_show" >/dev/null
grep -F 'ipv6.address: fd42:7365:7a75::1/64' <<<"$network_show" >/dev/null
incus profile show "$PROFILE" --project "$PROJECT" >/dev/null
for volume in u-work u-cache; do incus storage volume show "$POOL" "$volume" --project "$PROJECT" >/dev/null; done
if command -v ufw >/dev/null 2>&1; then
  ufw_status=$(ufw status)
  if grep -F 'Status: active' <<<"$ufw_status" >/dev/null; then
    grep -E '67/udp on sezu-br0.*ALLOW' <<<"$ufw_status" >/dev/null
    grep -E '53/udp on sezu-br0.*ALLOW' <<<"$ufw_status" >/dev/null
    grep -E 'ALLOW FWD.*on sezu-br0' <<<"$ufw_status" >/dev/null
  fi
fi
pass phase2-prerequisites

! incus info u-build --project "$PROJECT" >/dev/null 2>&1
u_info=$(incus info u --project "$PROJECT")
grep -Fx 'Status: RUNNING' <<<"$u_info" >/dev/null
golden=$(incus image info "$ALIAS" --project "$PROJECT" | awk '$1=="Fingerprint:" {print $2}')
test "$golden" = "$(python3 -c 'import json; print(json.load(open("config/forge/phase3.json"))["golden_fingerprint"])')"
python3 - <<PY
import json,subprocess
x=json.loads(subprocess.check_output(['incus','query','/1.0/instances/u?project=$PROJECT'],text=True))
assert x['profiles']==['$PROFILE'],x['profiles']
assert x['config'].get('boot.autostart')=='true',x['config']
for k in x['config']:
    assert not k.startswith('limits.'),k
assert x['config'].get('volatile.base_image')=='$golden',(x['config'].get('volatile.base_image'),'$golden')
PY
pass golden-production-instance

incus file push --project "$PROJECT" --mode 0755 "$REPO/scripts/phase3-forge-inside-check.sh" u/tmp/sezu-phase3-forge-check
incus exec u --project "$PROJECT" -- /tmp/sezu-phase3-forge-check u
incus exec u --project "$PROJECT" -- rm -f /tmp/sezu-phase3-forge-check
pass production-forge

incus exec u --project "$PROJECT" -- bash -c 'mountpoint -q /work && mountpoint -q /cache && systemctl is-active --quiet docker.service && ! systemctl is-active --quiet jupyter.service 2>/dev/null && ! test -e /run/sezu/supervisor.sock'
incus exec u --project "$PROJECT" -- bash -c 'test "$(docker image ls -q | wc -l)" -eq 0'
service_aliases=$(python3 - <<'PY'
import json
x=json.load(open('locks/service-images.json'))
for item in x['services']:
 print(item.get('template_id') or item.get('service') or item.get('name') or '')
PY
)
image_aliases=$(incus image alias list --project "$PROJECT" --format csv | cut -d, -f1)
while read -r alias; do test -z "$alias" || ! grep -Fx "$alias" <<<"$image_aliases" >/dev/null; done <<<"$service_aliases"
pass boundaries

printf 'phase3 forge check passed\n'
