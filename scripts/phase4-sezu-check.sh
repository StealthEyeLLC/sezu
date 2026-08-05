#!/bin/bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1" >&2; exit 1; }

[ -d /opt/sezu/releases/0.1.0 ] || fail release
[ "$(readlink -f /opt/sezu/current)" = /opt/sezu/releases/0.1.0 ] || fail current-link
[ -x /usr/local/bin/sezu ] || fail cli
[ "$(/opt/sezu/toolchains/node/24.19.0/bin/node --version)" = v24.19.0 ] || fail host-node
pass installation

systemctl is-enabled --quiet sezu-supervisor.service || fail supervisor-enabled
systemctl is-active --quiet sezu-supervisor.service || fail supervisor-active
systemctl restart sezu-supervisor.service
for _ in $(seq 1 100); do [ -S /run/sezu/supervisor.sock ] && break; sleep .1; done
[ "$(stat -c '%U:%G:%a' /run/sezu/supervisor.sock)" = root:sezu:660 ] || fail supervisor-socket
pass supervisor

default_lanes=$(sezu sezu.terminal.list --json)
for lane in u:main u:build u:debug host:main; do
  jq -e --arg lane "$lane" '.result.terminals | any(.name==$lane and .alive==true)' <<<"$default_lanes" >/dev/null || fail "default-terminal-$lane"
done
pass default-terminals

version=$(sezu sezu.version --json)
[ "$(jq -r .protocol <<<"$version")" = SEZU1/1.0.0 ] || fail protocol
[ "$(jq -r .result.version <<<"$version")" = 0.1.0 ] || fail version
health=$(sezu sezu.health --json)
jq -e '.ok and .result.ready' <<<"$health" >/dev/null || fail health
caps=$(sezu sezu.capabilities --json)
[ "$(jq -r .result.operation_count <<<"$caps")" = 184 ] || fail operation-count
[ "$(jq -r '.result.operations | unique | length' <<<"$caps")" = 184 ] || fail operation-unique
pass discovery

sezu sezu.exec --target host --args-json '{"argv":["/bin/printf","host-ok"]}' --json | jq -e '.ok and .stdout=="host-ok"' >/dev/null || fail host-exec
sezu sezu.exec --target u --args-json '{"argv":["/bin/printf","u-ok"]}' --json | jq -e '.ok and .stdout=="u-ok"' >/dev/null || fail u-exec
pass execution

runuser -u sezu-tunnel -- /opt/sezu/toolchains/node/24.19.0/bin/node /opt/sezu/current/scripts/mcp-smoke.mjs | jq -e '.ok and (.tools==["call_sezu"])' >/dev/null || fail mcp
pass gateway

/opt/sezu/toolchains/node/24.19.0/bin/node "$root/scripts/check-source.mjs" | jq -e '.ok and .handler_count==184' >/dev/null || fail source-catalog
pass handlers

python3 "$root/test/integration/phase4-core-check.py" | jq -e .ok >/dev/null || fail core-functional
pass core-functional
python3 "$root/test/integration/phase4-workspace-check.py" | jq -e .ok >/dev/null || fail workspace-skill-macro
pass workspace-skill-macro
python3 "$root/test/integration/phase4-browser-check.py" | jq -e .ok >/dev/null || fail browser
pass browser
python3 "$root/test/integration/phase4-cell-pack-check.py" | jq -e .ok >/dev/null || fail cell-pack-transfer
pass cell-pack-transfer
python3 "$root/test/integration/phase4-incus-check.py" | jq -e .ok >/dev/null || fail incus
pass incus
python3 "$root/test/integration/phase4-remaining-check.py" | jq -e .ok >/dev/null || fail templates-timer-backup
pass templates-timer-backup

[ "$(/opt/sezu/toolchains/tunnel-client/0.0.10/tunnel-client --version | cut -d+ -f1)" = 0.0.10 ] || fail tunnel-client
! systemctl is-enabled --quiet sezu-tunnel.service || fail tunnel-enabled
! systemctl is-active --quiet sezu-tunnel.service || fail tunnel-active
[ ! -e /etc/sezu/credentials/tunnel-client.yaml ] || fail tunnel-credentials
! pgrep -x tunnel-client >/dev/null || fail tunnel-process
supervisor_pid=$(systemctl show -p MainPID --value sezu-supervisor.service)
! ss -H -lntup | grep -q "pid=$supervisor_pid," || fail public-listener
pass tunnel-boundary

systemctl is-active --quiet baby-quirt.socket || fail baby-socket
systemctl is-active --quiet baby-quirt-mcp.service || fail baby-mcp
systemctl is-active --quiet sezu-initialization-baby-guard.timer || fail init-guard
incus list u --project sezu --format csv -c s | grep -qx RUNNING || fail production-u
incus image alias list --project sezu --format csv | grep -q '^sezu-u-golden-0.1.0,' || fail golden-image
pass preservation

printf 'PASS phase4\n'
