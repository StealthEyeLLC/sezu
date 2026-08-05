#!/bin/bash
set -euo pipefail
exec /opt/sezu/toolchains/tunnel-client/0.0.10/tunnel-client run \
  --config /etc/sezu/credentials/tunnel-client.yaml \
  --health.unix-socket /run/sezu/tunnel-health.sock \
  --mcp.command "command=/opt/sezu/toolchains/node/24.19.0/bin/node /opt/sezu/current/src/gateway.mjs,channel=main"
