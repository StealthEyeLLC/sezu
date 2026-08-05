#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
client=/opt/sezu/toolchains/tunnel-client/0.0.10/tunnel-client
config=/etc/sezu/credentials/tunnel-client.yaml
key=/etc/sezu/credentials/control-plane-api-key
health=/run/sezu/tunnel-health.sock
pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; exit 1; }

[ "$(readlink -f /opt/sezu/current)" = /opt/sezu/releases/0.1.0 ] || fail release
[ "$(/opt/sezu/toolchains/node/24.19.0/bin/node --version)" = v24.19.0 ] || fail node
expected='0.0.10+105e17a79a36e4e5c897fd698ed2b8dbf935b144 (git sha: 105e17a79a36e4e5c897fd698ed2b8dbf935b144)'
[ "$($client --version)" = "$expected" ] || fail tunnel-client
pass identity

[ "$(stat -c '%U:%G:%a' /etc/sezu)" = root:sezu:750 ] || fail config-directory
[ "$(stat -c '%U:%G:%a' /etc/sezu/credentials)" = root:sezu:750 ] || fail credential-directory
[ "$(stat -c '%U:%G:%a' "$config")" = root:sezu:640 ] || fail tunnel-config-mode
[ "$(stat -c '%U:%G:%a' "$key")" = root:sezu:640 ] || fail tunnel-key-mode
[ -s "$key" ] || fail tunnel-key-empty
python3 - "$config" <<'PY' || exit 1
import re,sys,yaml
x=yaml.safe_load(open(sys.argv[1])); cp=(x or {}).get('control_plane') or {}
assert x.get('config_version') == 1
assert cp.get('base_url','https://api.openai.com') == 'https://api.openai.com'
assert re.fullmatch(r'tunnel_[0-9a-f]{32}',str(cp.get('tunnel_id','')))
assert cp.get('api_key') == 'file:/etc/sezu/credentials/control-plane-api-key'
assert 'health' not in x and 'mcp' not in x
flat=str(x).lower().replace('-','_')
for s in ('allow_remote_ui','health_listen_addr','log_http_raw_unsafe','harpoon_capture_payloads'):
    assert s not in flat
PY
pass credentials

systemctl is-enabled --quiet sezu-supervisor.service || fail supervisor-enabled
systemctl is-active --quiet sezu-supervisor.service || fail supervisor-active
[ "$(stat -c '%U:%G:%a' /run/sezu/supervisor.sock)" = root:sezu:660 ] || fail supervisor-socket
sezu sezu.health --json | jq -e '.ok and .protocol=="SEZU1/1.0.0" and .result.ready' >/dev/null || fail local-health
sezu sezu.version --json | jq -e '.ok and .result.product=="sezu" and .result.version=="0.1.0"' >/dev/null || fail local-version
sezu sezu.capabilities --json | jq -e '.ok and .result.operation_count==184 and (.result.operations|unique|length)==184' >/dev/null || fail local-capabilities
runuser -u sezu-tunnel -- /opt/sezu/toolchains/node/24.19.0/bin/node /opt/sezu/current/scripts/mcp-smoke.mjs | jq -e '.ok and .tools==["call_sezu"]' >/dev/null || fail gateway
pass local-runtime

systemctl is-enabled --quiet sezu-tunnel.service || fail tunnel-enabled
systemctl is-active --quiet sezu-tunnel.service || fail tunnel-active
[ "$(systemctl show sezu-tunnel.service -p User --value)" = sezu-tunnel ] || fail tunnel-user
[ "$(systemctl show sezu-tunnel.service -p Group --value)" = sezu ] || fail tunnel-group
case " $(systemctl show sezu-tunnel.service -p SupplementaryGroups --value) " in *' sezu '*) ;; *) fail tunnel-supplementary-group;; esac
[ -S "$health" ] || fail tunnel-health-socket
curl --unix-socket "$health" -fsS http://localhost/healthz >/dev/null || fail tunnel-health
curl --unix-socket "$health" -fsS http://localhost/readyz >/dev/null || fail tunnel-readiness
main_pid=$(systemctl show sezu-tunnel.service -p MainPID --value)
[ "$main_pid" -gt 1 ] || fail tunnel-main-pid
tr '\0' ' ' < "/proc/$main_pid/cmdline" | grep -Fq '/opt/sezu/toolchains/tunnel-client/0.0.10/tunnel-client run' || fail tunnel-command
tr '\0' ' ' < "/proc/$main_pid/cmdline" | grep -Fq 'channel=main' || fail tunnel-channel
pgrep -P "$main_pid" -a | grep -Fq '/opt/sezu/current/src/gateway.mjs' || fail gateway-child
pass tunnel-runtime

service_env=$(systemctl show sezu-tunnel.service -p Environment --value)
for name in CONTROL_PLANE_TUNNEL_ID CONTROL_PLANE_API_KEY OPENAI_API_KEY TUNNEL_CLIENT_CONFIG TUNNEL_CLIENT_PROFILE TUNNEL_CLIENT_PROFILE_FILE MCP_COMMAND MCP_SERVER_URL HEALTH_LISTEN_ADDR ALLOW_REMOTE_UI; do
  case " $service_env " in *" $name="*) fail "environment-$name";; esac
done
pids="$main_pid $(pgrep -P "$main_pid" || true)"
for pid in $pids; do
  ss -H -lntup | grep -q "pid=$pid," && fail public-sezu-listener
done
ss -H -lnt | awk '$4 ~ /^(0\.0\.0\.0|\[::\]|51\.81\.86\.225|\[2604:2dc0:121:3e2::1\]):/ {print}' | grep -Ei 'sezu|tunnel' && fail public-sezu-listener
pass outbound-only

systemctl is-active --quiet baby-quirt.socket || fail baby-socket
systemctl is-active --quiet baby-quirt.service || fail baby-service
systemctl is-active --quiet baby-quirt-mcp.service || fail baby-mcp
systemctl is-enabled --quiet sezu-initialization-baby-guard.timer || fail init-guard-enabled
systemctl is-active --quiet sezu-initialization-baby-guard.timer || fail init-guard-active
incus list u --project sezu --format csv -c s | grep -qx RUNNING || fail production-u
incus image alias list --project sezu --format csv | grep -q '^sezu-u-golden-0.1.0,' || fail golden-image
pass preservation

! find "$root" -maxdepth 3 -type f -iname '*phase6*' -print -quit | grep -q . || fail phase6-artifact
pass phase-boundary
printf 'PASS phase5-local\n'
