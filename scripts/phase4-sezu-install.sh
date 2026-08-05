#!/bin/bash
set -euo pipefail
release_source=${1:?usage: phase4-sezu-install.sh RELEASE_DIRECTORY}
[ -d "$release_source" ] || { echo "release directory missing: $release_source" >&2; exit 2; }
repo_root=$(cd "$(dirname "$0")/.." && pwd)
node_archive=/var/cache/sezu/sources/direct/nodejs/24.19.0/node-v24.19.0-linux-x64.tar.xz
tunnel_archive=/var/cache/sezu/sources/direct/openai-tunnel-client/0.0.10/tunnel-client-v0.0.10-linux-amd64.zip
printf '%s  %s\n' 14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647 "$node_archive" | sha256sum -c -
printf '%s  %s\n' b9e0388a343f2d7adeff3992f411a0bd3d916a64bc56534aac5fd15ac1b20cd5 "$tunnel_archive" | sha256sum -c -
getent group sezu >/dev/null
id sezu-tunnel >/dev/null
usermod -a -G sezu sezu-tunnel
systemd-tmpfiles --create "$repo_root/systemd/tmpfiles/sezu.conf"

node_root=/opt/sezu/toolchains/node/24.19.0
if [ ! -x "$node_root/bin/node" ] || [ "$($node_root/bin/node --version 2>/dev/null || true)" != v24.19.0 ]; then
  temp=$(mktemp -d /opt/sezu/toolchains/.node-24.19.0.XXXXXX)
  tar -xJf "$node_archive" -C "$temp"
  stage=/opt/sezu/toolchains/node/.24.19.0.stage.$$
  rm -rf "$stage"; mkdir -p "$stage"
  cp -a "$temp/node-v24.19.0-linux-x64/." "$stage/"
  rm -rf "$node_root"
  mv "$stage" "$node_root"
  rm -rf "$temp"
fi
[ "$($node_root/bin/node --version)" = v24.19.0 ]

tunnel_root=/opt/sezu/toolchains/tunnel-client/0.0.10
if [ ! -x "$tunnel_root/tunnel-client" ]; then
  stage=/opt/sezu/toolchains/tunnel-client/.0.0.10.stage.$$
  rm -rf "$stage"; mkdir -p "$stage"
  unzip -q "$tunnel_archive" -d "$stage"
  chmod 0755 "$stage/tunnel-client"
  rm -rf "$tunnel_root"
  mv "$stage" "$tunnel_root"
fi
"$tunnel_root/tunnel-client" --version | grep -q '^0\.0\.10+'

systemctl stop sezu-supervisor.service 2>/dev/null || true
stage=/opt/sezu/releases/.0.1.0.stage.$$
rm -rf "$stage"; mkdir -p "$stage"
cp -a "$release_source/." "$stage/"
[ -x "$stage/src/supervisor.mjs" ]
[ -x "$stage/src/gateway.mjs" ]
[ -x "$stage/src/cli.mjs" ]
[ -d "$stage/node_modules/@modelcontextprotocol/sdk" ]
[ "$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["operations"].__len__())' "$stage/config/operations/catalog.json")" = 184 ]
rm -rf /opt/sezu/releases/0.1.0
mv "$stage" /opt/sezu/releases/0.1.0
chmod -R a+rX /opt/sezu/releases/0.1.0
ln -sfn /opt/sezu/releases/0.1.0 /opt/sezu/current

mkdir -p /opt/sezu/skills
rsync -a --delete /opt/sezu/current/skills/ /opt/sezu/skills/
install -m 0644 /opt/sezu/current/systemd/sezu-supervisor.service /etc/systemd/system/sezu-supervisor.service
install -m 0644 /opt/sezu/current/systemd/sezu-tunnel.service /etc/systemd/system/sezu-tunnel.service
cat > /usr/local/bin/sezu <<'EOF'
#!/bin/bash
exec /opt/sezu/toolchains/node/24.19.0/bin/node /opt/sezu/current/src/cli.mjs "$@"
EOF
cat > /usr/local/bin/sezu-gateway <<'EOF'
#!/bin/bash
exec /opt/sezu/toolchains/node/24.19.0/bin/node /opt/sezu/current/src/gateway.mjs "$@"
EOF
chmod 0755 /usr/local/bin/sezu /usr/local/bin/sezu-gateway
if [ ! -f /etc/sezu/config.json ]; then
  printf '{"default_target":"u"}\n' > /etc/sezu/config.json
  chmod 0600 /etc/sezu/config.json
fi
rm -f /etc/sezu/credentials/tunnel-client.yaml /run/sezu/tunnel-health.sock
systemctl daemon-reload
systemctl disable --now sezu-tunnel.service 2>/dev/null || true
systemctl enable --now sezu-supervisor.service
for i in $(seq 1 100); do [ -S /run/sezu/supervisor.sock ] && break; sleep 0.1; done
[ -S /run/sezu/supervisor.sock ]
[ "$(stat -c '%U:%G:%a' /run/sezu/supervisor.sock)" = root:sezu:660 ]
for spec in 'u:main u' 'u:build u' 'u:debug u' 'host:main host'; do
  set -- $spec
  name=$1
  target=$2
  if ! /usr/local/bin/sezu sezu.terminal.create --target "$target" --args-json "{\"name\":\"$name\"}" --json >/tmp/sezu-terminal-create.json; then
    grep -q 'terminal_exists' /tmp/sezu-terminal-create.json || { cat /tmp/sezu-terminal-create.json >&2; exit 1; }
    if ! /usr/local/bin/sezu sezu.terminal.open --args-json "{\"name\":\"$name\"}" --json >/tmp/sezu-terminal-open.json; then
      grep -q 'terminal_not_running' /tmp/sezu-terminal-open.json || { cat /tmp/sezu-terminal-open.json >&2; exit 1; }
      /usr/local/bin/sezu sezu.terminal.delete --args-json "{\"name\":\"$name\"}" --json >/dev/null
      /usr/local/bin/sezu sezu.terminal.create --target "$target" --args-json "{\"name\":\"$name\"}" --json >/dev/null
    fi
  fi
done
rm -f /tmp/sezu-terminal-create.json /tmp/sezu-terminal-open.json
/usr/local/bin/sezu --version
/usr/local/bin/sezu sezu.version --json
