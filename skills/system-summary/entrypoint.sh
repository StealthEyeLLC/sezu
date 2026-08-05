#!/bin/bash
set -euo pipefail
input=${1-}
[ -n "$input" ] || input='{}'
target=$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]).get("target", "u"))' "$input")
exec /usr/local/bin/sezu sezu.exec --target "$target" --args-json '{"argv":["/bin/bash","-lc","printf \"hostname=%s\\n\" \"$(hostname)\"; printf \"kernel=%s\\n\" \"$(uname -r)\"; printf \"uptime_seconds=%s\\n\" \"$(cut -d. -f1 /proc/uptime)\"; printf \"root_bytes=%s\\n\" \"$(df -B1 --output=avail / | tail -1 | tr -d \" \" )\""]}' --json
