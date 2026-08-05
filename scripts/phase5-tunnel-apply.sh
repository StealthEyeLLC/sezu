#!/bin/bash
set -euo pipefail

credential_dir=/etc/sezu/credentials
config_path=$credential_dir/tunnel-client.yaml
key_path=$credential_dir/control-plane-api-key
client=/opt/sezu/toolchains/tunnel-client/0.0.10/tunnel-client
health_socket=/run/sezu/tunnel-health.sock
node=/opt/sezu/toolchains/node/24.19.0/bin/node
gateway=/opt/sezu/current/src/gateway.mjs
mcp_command="command=$node $gateway,channel=main"
config_source=${SEZU_TUNNEL_CONFIG_SOURCE:-}
key_source=${SEZU_TUNNEL_KEY_SOURCE:-}
tunnel_id=${SEZU_TUNNEL_ID:-}
organization_id=${SEZU_OPENAI_ORGANIZATION_ID:-}

usage() {
  cat <<'USAGE'
usage: phase5-tunnel-apply.sh [--config FILE] [--runtime-key-file FILE]
                              [--tunnel-id ID] [--organization-id ID]

Reuse the installed credential when no input is supplied. To generate the
minimal production YAML, provide --tunnel-id and --runtime-key-file.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config) config_source=${2:?missing value for --config}; shift 2 ;;
    --runtime-key-file) key_source=${2:?missing value for --runtime-key-file}; shift 2 ;;
    --tunnel-id) tunnel_id=${2:?missing value for --tunnel-id}; shift 2 ;;
    --organization-id) organization_id=${2:?missing value for --organization-id}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo 'phase5 apply must run as root' >&2; exit 77; }
[ -x "$client" ] || { echo 'locked tunnel-client is missing' >&2; exit 1; }
version=$($client --version)
case "$version" in
  '0.0.10+105e17a79a36e4e5c897fd698ed2b8dbf935b144 (git sha: 105e17a79a36e4e5c897fd698ed2b8dbf935b144)') ;;
  *) echo "unexpected tunnel-client version: $version" >&2; exit 1 ;;
esac
systemctl is-active --quiet sezu-supervisor.service || { echo 'sezu-supervisor.service is not active' >&2; exit 1; }
[ -S /run/sezu/supervisor.sock ] || { echo 'supervisor socket is missing' >&2; exit 1; }
getent group sezu >/dev/null
id sezu-tunnel >/dev/null
install -d -o root -g sezu -m 0750 /etc/sezu
install -d -o root -g sezu -m 0750 "$credential_dir"

tmp_config=
tmp_doctor=
cleanup() {
  [ -z "$tmp_config" ] || rm -f "$tmp_config"
  [ -z "$tmp_doctor" ] || rm -f "$tmp_doctor"
}
trap cleanup EXIT HUP INT TERM

if [ -n "$key_source" ]; then
  [ -f "$key_source" ] || { echo "runtime key source is missing: $key_source" >&2; exit 1; }
  [ -s "$key_source" ] || { echo 'runtime key source is empty' >&2; exit 1; }
  if [ ! -f "$key_path" ] || ! cmp -s "$key_source" "$key_path"; then
    install -o root -g sezu -m 0640 "$key_source" "$key_path"
  fi
elif [ ! -s "$key_path" ]; then
  echo 'no runtime key is installed; provide --runtime-key-file' >&2
  exit 1
fi

if [ -n "$config_source" ] && [ -n "$tunnel_id" ]; then
  echo 'use either --config or --tunnel-id, not both' >&2
  exit 64
fi
if [ -n "$config_source" ]; then
  [ -f "$config_source" ] || { echo "configuration source is missing: $config_source" >&2; exit 1; }
  if [ ! -f "$config_path" ] || ! cmp -s "$config_source" "$config_path"; then
    install -o root -g sezu -m 0640 "$config_source" "$config_path"
  fi
elif [ -n "$tunnel_id" ]; then
  case "$tunnel_id" in
    tunnel_[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
    *) echo 'invalid tunnel id' >&2; exit 64 ;;
  esac
  tmp_config=$(mktemp "$credential_dir/.tunnel-client.XXXXXX")
  {
    printf 'config_version: 1\n'
    printf 'control_plane:\n'
    printf '  base_url: "https://api.openai.com"\n'
    printf '  tunnel_id: "%s"\n' "$tunnel_id"
    printf '  api_key: "file:/etc/sezu/credentials/control-plane-api-key"\n'
    if [ -n "$organization_id" ]; then
      printf '  organization_id: "%s"\n' "$organization_id"
    fi
    printf 'admin_ui:\n'
    printf '  open_browser: false\n'
    printf 'log:\n'
    printf '  level: info\n'
    printf '  format: json\n'
  } > "$tmp_config"
  chown root:sezu "$tmp_config"
  chmod 0640 "$tmp_config"
  if [ ! -f "$config_path" ] || ! cmp -s "$tmp_config" "$config_path"; then
    install -o root -g sezu -m 0640 "$tmp_config" "$config_path"
  fi
elif [ ! -f "$config_path" ]; then
  echo 'no tunnel configuration is installed; provide --config or --tunnel-id' >&2
  exit 1
fi

chown root:sezu "$config_path" "$key_path"
chmod 0640 "$config_path" "$key_path"

python3 - "$config_path" <<'PY'
import re, sys, yaml
p=sys.argv[1]
o=yaml.safe_load(open(p))
if not isinstance(o,dict) or o.get('config_version') != 1: raise SystemExit('invalid config_version')
cp=o.get('control_plane') or {}
if cp.get('base_url','https://api.openai.com') != 'https://api.openai.com': raise SystemExit('unexpected control-plane URL')
if not re.fullmatch(r'tunnel_[0-9a-f]{32}', str(cp.get('tunnel_id',''))): raise SystemExit('invalid tunnel id')
if cp.get('api_key') != 'file:/etc/sezu/credentials/control-plane-api-key': raise SystemExit('runtime key must use the dedicated file reference')
if 'mcp' in o or 'health' in o: raise SystemExit('MCP child and Unix health socket belong to run-tunnel.sh, not YAML')
forbidden={'allow_remote_ui','open_web_ui','health_listen_addr','log_http_raw_unsafe','harpoon_capture_payloads'}
def walk(v,path=''):
    if isinstance(v,dict):
        for k,x in v.items():
            n=(path+'.'+str(k) if path else str(k)).lower().replace('-','_')
            if n in forbidden or str(k).lower().replace('-','_') in forbidden: raise SystemExit('forbidden setting: '+n)
            walk(x,n)
    elif isinstance(v,list):
        for x in v: walk(x,path)
walk(o)
PY

service_env=$(systemctl show sezu-tunnel.service -p Environment --value)
for name in CONTROL_PLANE_TUNNEL_ID CONTROL_PLANE_API_KEY OPENAI_API_KEY TUNNEL_CLIENT_CONFIG TUNNEL_CLIENT_PROFILE TUNNEL_CLIENT_PROFILE_FILE MCP_COMMAND MCP_SERVER_URL HEALTH_LISTEN_ADDR ALLOW_REMOTE_UI; do
  case " $service_env " in *" $name="*) echo "conflicting systemd environment: $name" >&2; exit 1;; esac
done

runuser -u sezu-tunnel -- "$node" /opt/sezu/current/scripts/mcp-smoke.mjs >/dev/null

tmp_doctor=$(mktemp /tmp/sezu-tunnel-doctor.XXXXXX.json)
runuser -u sezu-tunnel -- "$client" doctor \
  --config "$config_path" \
  --health.unix-socket "$health_socket" \
  --mcp.command "$mcp_command" \
  --json > "$tmp_doctor"

systemctl daemon-reload
systemctl enable --now sezu-tunnel.service >/dev/null
for _ in $(seq 1 300); do
  systemctl is-active --quiet sezu-tunnel.service && [ -S "$health_socket" ] && break
  sleep .2
done
systemctl is-active --quiet sezu-tunnel.service || { systemctl --no-pager --full status sezu-tunnel.service >&2; exit 1; }
[ -S "$health_socket" ] || { echo 'tunnel health socket did not appear' >&2; exit 1; }
for _ in $(seq 1 300); do
  if curl --unix-socket "$health_socket" -fsS http://localhost/healthz >/dev/null 2>&1 && \
     curl --unix-socket "$health_socket" -fsS http://localhost/readyz >/dev/null 2>&1; then
    break
  fi
  sleep .2
done
curl --unix-socket "$health_socket" -fsS http://localhost/healthz >/dev/null
curl --unix-socket "$health_socket" -fsS http://localhost/readyz >/dev/null

printf 'tunnel_client=%s\n' "$version"
printf 'credential_config=%s\n' "$config_path"
printf 'service_enabled=%s\n' "$(systemctl is-enabled sezu-tunnel.service)"
printf 'service_active=%s\n' "$(systemctl is-active sezu-tunnel.service)"
printf 'health=ok\nreadiness=ok\nhealth_socket=%s\n' "$health_socket"
