#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
REPO=$(cd "$(dirname "$0")/.." && pwd)
PROJECT=sezu
POOL=sezu-btrfs
PROFILE=sezu-u-power
BUILD=u-build
PRODUCTION=u
ALIAS=sezu-u-golden-0.1.0
SOURCE_FP=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["incus_image_fingerprint"])' "$REPO/locks/ubuntu-image.json")
IMAGE_TMP=/var/cache/sezu-phase3-image
INITIAL_GUARD_HASH=$(systemctl cat sezu-initialization-baby-guard.service sezu-initialization-baby-guard.timer --no-pager | sha256sum | awk '{print $1}')
log() { printf '\n[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }
baby_health() {
  systemctl is-active --quiet baby-quirt.socket
  systemctl is-active --quiet baby-quirt-mcp.service
  systemctl is-active --quiet sezu-initialization-baby-guard.timer
}
instance_exists() { incus info "$1" --project "$PROJECT" >/dev/null 2>&1; }
alias_fingerprint() { incus image info "$ALIAS" --project "$PROJECT" 2>/dev/null | awk '$1=="Fingerprint:" {print $2}'; }
ensure_network_config() {
  local name=$1
  incus file push --project "$PROJECT" "$REPO/config/forge/10-sezu-eth0.network" "$name/etc/systemd/network/10-sezu-eth0.network"
  incus exec "$name" --project "$PROJECT" -- systemctl restart systemd-networkd.service
}
ensure_host_firewall() {
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
    local wan
    wan=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}' | head -n1)
    ufw allow in on sezu-br0 proto udp to any port 67 comment 'SEZU Incus DHCPv4' >/dev/null
    ufw allow in on sezu-br0 proto udp to any port 547 comment 'SEZU Incus DHCPv6' >/dev/null
    ufw allow in on sezu-br0 proto udp to any port 53 comment 'SEZU Incus DNS UDP' >/dev/null
    ufw allow in on sezu-br0 proto tcp to any port 53 comment 'SEZU Incus DNS TCP' >/dev/null
    ufw route allow in on sezu-br0 out on "$wan" comment 'SEZU Incus outbound' >/dev/null
    ufw reload >/dev/null
  fi
}
wait_ready() {
  local name=$1 state
  for _ in $(seq 1 240); do
    if incus exec "$name" --project "$PROJECT" -- test -S /run/dbus/system_bus_socket >/dev/null 2>&1; then
      state=$(incus exec "$name" --project "$PROJECT" -- systemctl is-system-running 2>/dev/null || true)
      case "$state" in running|degraded) break;; esac
    fi
    sleep 1
  done
  case "${state:-}" in running|degraded) :;; *) echo "systemd did not become ready in $name" >&2; return 1;; esac
  incus exec "$name" --project "$PROJECT" -- bash -c 'if command -v cloud-init >/dev/null && ! cloud-init status 2>/dev/null | grep -q "status: disabled"; then timeout 180 cloud-init status --wait >/dev/null 2>&1 || true; fi'
  incus exec "$name" --project "$PROJECT" -- bash -c 'for i in $(seq 1 120); do ip -4 address show dev eth0 | grep -q "10.177.0." && getent ahostsv4 pypi.org >/dev/null && timeout 15 curl -4fsS https://pypi.org/ >/dev/null && timeout 15 curl -6fsS https://pypi.org/ >/dev/null && exit 0; sleep 1; done; exit 1'
}
push_repo() {
  local name=$1 tarball
  tarball=$(mktemp /tmp/sezu-phase3-repo.XXXXXX.tar.gz)
  tar --exclude=.git -C "$REPO" -czf "$tarball" .
  incus file push --project "$PROJECT" "$tarball" "$name/tmp/sezu-phase3-repo.tar.gz"
  rm -f "$tarball"
  incus exec "$name" --project "$PROJECT" -- bash -c 'rm -rf /opt/sezu-build/repo; mkdir -p /opt/sezu-build/repo; tar -xzf /tmp/sezu-phase3-repo.tar.gz -C /opt/sezu-build/repo; rm -f /tmp/sezu-phase3-repo.tar.gz'
}

cd "$REPO"
log validate
baby_health
ensure_host_firewall
python3 scripts/validate-locks.py
python3 scripts/phase3-pack-select.py
remote=$(gh api repos/StealthEyeLLC/sezu/git/ref/heads/main --jq .object.sha)
test "$remote" = "$(git rev-parse HEAD)"
test -z "$(git status --short --untracked-files=no)" || true

golden=$(alias_fingerprint || true)
if ! instance_exists "$PRODUCTION" || test -z "$golden"; then
  log source-image
  if ! incus image info "$SOURCE_FP" --project "$PROJECT" >/dev/null 2>&1; then
    rm -rf "$IMAGE_TMP"
    python3 scripts/phase3-locked-fetch.py image --cache "$IMAGE_TMP"
    metadata=$(python3 -c 'import json; x=json.load(open("/var/cache/sezu-phase3-image/sources/images/locked-index.json")); print(next(i["cache_path"] for i in x if i["role"]=="metadata"))')
    rootfs=$(python3 -c 'import json; x=json.load(open("/var/cache/sezu-phase3-image/sources/images/locked-index.json")); print(next(i["cache_path"] for i in x if i["role"]=="rootfs-tar-xz"))')
    incus image import "$metadata" "$rootfs" --project "$PROJECT"
    incus image info "$SOURCE_FP" --project "$PROJECT" >/dev/null
  fi

  if ! instance_exists "$BUILD" && test -z "$golden"; then
    log create-build-instance
    incus init "$SOURCE_FP" "$BUILD" --project "$PROJECT" --profile "$PROFILE"
    incus config show "$BUILD" --project "$PROJECT" --format json | python3 -c 'import json,sys; assert json.load(sys.stdin)["profiles"]==["sezu-u-power"]'
  fi
  if instance_exists "$BUILD"; then
    status=$(incus info "$BUILD" --project "$PROJECT" | awk '/^Status:/{print $2}')
    test "$status" = RUNNING || incus start "$BUILD" --project "$PROJECT"
    ensure_network_config "$BUILD"
    wait_ready "$BUILD"
    push_repo "$BUILD"
    log build-forge
    incus exec "$BUILD" --project "$PROJECT" -- bash /opt/sezu-build/repo/scripts/phase3-forge-container.sh

    work_token=$(openssl rand -hex 24)
    cache_token=$(openssl rand -hex 24)
    incus exec "$BUILD" --project "$PROJECT" -- bash -c "printf '%s' '$work_token' > /work/.sezu-phase3-persistence && printf '%s' '$cache_token' > /cache/.sezu-phase3-persistence"

    log prepare-image
    incus exec "$BUILD" --project "$PROJECT" -- bash /opt/sezu-build/repo/scripts/phase3-forge-clean.sh
    incus stop "$BUILD" --project "$PROJECT" --timeout 120
    if test -z "$golden"; then
      incus publish "$BUILD" --project "$PROJECT" --alias "$ALIAS"
      golden=$(alias_fingerprint)
      test -n "$golden"
    fi
    if instance_exists u-image-smoke; then incus delete u-image-smoke --project "$PROJECT" --force; fi
    incus init "$ALIAS" u-image-smoke --project "$PROJECT" --no-profiles --storage "$POOL"
    incus delete u-image-smoke --project "$PROJECT" --force
    incus delete "$BUILD" --project "$PROJECT"

    log launch-production
    if instance_exists "$PRODUCTION"; then incus delete "$PRODUCTION" --project "$PROJECT" --force; fi
    incus init "$ALIAS" "$PRODUCTION" --project "$PROJECT" --profile "$PROFILE"
    incus config set "$PRODUCTION" boot.autostart true --project "$PROJECT"
    incus start "$PRODUCTION" --project "$PROJECT"
    wait_ready "$PRODUCTION"
    test "$(incus exec "$PRODUCTION" --project "$PROJECT" -- cat /work/.sezu-phase3-persistence)" = "$work_token"
    test "$(incus exec "$PRODUCTION" --project "$PROJECT" -- cat /cache/.sezu-phase3-persistence)" = "$cache_token"
    incus exec "$PRODUCTION" --project "$PROJECT" -- rm -f /work/.sezu-phase3-persistence /cache/.sezu-phase3-persistence
  elif test -n "$golden" && ! instance_exists "$PRODUCTION"; then
    incus init "$ALIAS" "$PRODUCTION" --project "$PROJECT" --profile "$PROFILE"
    incus config set "$PRODUCTION" boot.autostart true --project "$PROJECT"
    incus start "$PRODUCTION" --project "$PROJECT"
    wait_ready "$PRODUCTION"
  fi
fi

golden=$(alias_fingerprint)
test -n "$golden"
python3 - "$golden" <<'PY'
import json,sys
p='config/forge/phase3.json'
x=json.load(open(p)); x['golden_fingerprint']=sys.argv[1]
open(p,'w').write(json.dumps(x,indent=2,sort_keys=True)+'\n')
PY
rm -rf "$IMAGE_TMP"
log final-check
scripts/phase3-forge-check.sh
baby_health
test "$INITIAL_GUARD_HASH" = "$(systemctl cat sezu-initialization-baby-guard.service sezu-initialization-baby-guard.timer --no-pager | sha256sum | awk '{print $1}')"
incus version | awk '$1=="Client" && $2=="version:" && $3=="6.0.6" {ok=1} END {exit !ok}'
printf 'phase3 live apply complete; golden=%s\n' "$golden"
