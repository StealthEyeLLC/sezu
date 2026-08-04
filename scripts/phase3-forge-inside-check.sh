#!/usr/bin/env bash
set -euo pipefail
expected_name=${1:-}
export PATH=/usr/local/bin:/opt/sezu/packs/document-core/venv/bin:/opt/sezu/packs/data-core/venv/bin:/opt/sezu/packs/sezu-core/node/node_modules/.bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
export PLAYWRIGHT_BROWSERS_PATH=/opt/sezu/toolchains/playwright
export SEZU_CHROMIUM_EXECUTABLE="$(cat /opt/sezu/toolchains/playwright/chromium-path)"
TMP=$(mktemp -d /tmp/sezu-phase3-check.XXXXXX)
cleanup() {
  set +e
  test -n "${http_pid:-}" && kill "$http_pid" 2>/dev/null
  test -n "${qemu_pid:-}" && kill "$qemu_pid" 2>/dev/null
  docker rm -f sezu-phase3-test >/dev/null 2>&1
  docker image rm -f sezu-phase3-test:local >/dev/null 2>&1
  docker network rm sezu-phase3-net >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT
pass() { printf 'ok %s\n' "$1"; }

if test -n "$expected_name"; then test "$(hostname)" = "$expected_name"; fi
grep -q '^VERSION_ID="24.04"' /etc/os-release
test "$(uname -m)" = x86_64
mountpoint -q /work; mountpoint -q /cache
test -w /work && test -w /cache
ip -4 address show dev eth0 | grep -q '10\.177\.0\.'
ip -6 address show dev eth0 | grep -q 'fd42:7365:7a75:'
getent ahostsv4 pypi.org >/dev/null
curl -4fsS --max-time 20 https://pypi.org/ >/dev/null
curl -6fsS --max-time 20 https://pypi.org/ >/dev/null
test -r /dev/kvm && test -w /dev/kvm
test -c /dev/net/tun && test -c /dev/fuse && test -c /dev/vhost-net && test -c /dev/vhost-vsock
test "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs
pass platform-network-devices

test "$(node --version)" = v24.19.0
test "$(dpkg-query -W -f='${Version}' docker.io)" = '29.1.3-0ubuntu3~24.04.2'
docker version >/dev/null
docker info >/dev/null
docker buildx version >/dev/null
docker compose version >/dev/null
skopeo --version >/dev/null
python3 - <<'PY'
import json
x=json.load(open('/etc/docker/daemon.json'))['default-address-pools']
assert x == [{'base':'172.30.0.0/16','size':24}], x
PY
docker network create sezu-phase3-net >/dev/null
subnet=$(docker network inspect sezu-phase3-net -f '{{(index .IPAM.Config 0).Subnet}}')
case "$subnet" in 172.30.*.0/24) ;; *) echo "unexpected Docker subnet $subnet" >&2; exit 1;; esac
docker network rm sezu-phase3-net >/dev/null
mkdir -p "$TMP/docker"
cat > "$TMP/docker/main.go" <<'EOF'
package main
import "fmt"
func main(){fmt.Println("sezu-docker-ok")}
EOF
(cd "$TMP/docker" && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o hello main.go)
cat > "$TMP/docker/Dockerfile" <<'EOF'
FROM scratch
COPY hello /hello
ENTRYPOINT ["/hello"]
EOF
docker build -q -t sezu-phase3-test:local "$TMP/docker" >/dev/null
test "$(docker run --name sezu-phase3-test --rm sezu-phase3-test:local)" = sezu-docker-ok
docker image rm sezu-phase3-test:local >/dev/null
pass docker

cat > "$TMP/hello.c" <<'EOF'
#include <stdio.h>
int main(void){puts("sezu-native-ok");return 0;}
EOF
cc -O2 "$TMP/hello.c" -o "$TMP/hello"
test "$($TMP/hello)" = sezu-native-ok
cmake --version >/dev/null
ninja --version >/dev/null
meson --version >/dev/null
clang --version >/dev/null
rustc --version >/dev/null
cargo --version >/dev/null
go version >/dev/null
java -version 2>&1 | head -n1 >/dev/null
mvn --version >/dev/null
gradle --version >/dev/null
bazel --version >/dev/null
conan --version >/dev/null
vcpkg version >/dev/null
pass compilers-build-tools

mkdir "$TMP/repo"; cd "$TMP/repo"
git init -q
git config user.name SEZU
git config user.email sezu@localhost
printf 'forge\n' > forge.txt
git add forge.txt && git commit -qm forge
test "$(git show HEAD:forge.txt)" = forge
git-lfs version >/dev/null
gh --version >/dev/null
glab --version >/dev/null
hg --version >/dev/null
svn --version --quiet >/dev/null
pass repository-tools

/opt/sezu/packs/data-core/venv/bin/python - <<'PY'
from pathlib import Path
import numpy as np, scipy, pandas as pd, polars as pl, sklearn, pyarrow as pa, pyarrow.parquet as pq, duckdb, cv2
from osgeo import gdal
p=Path('/tmp/sezu-phase3-data.parquet')
df=pl.DataFrame({'x':[1,2,3], 'y':[4,5,6]})
df.write_parquet(p)
assert pl.read_parquet(p)['x'].sum()==6
assert duckdb.sql(f"select sum(y) from read_parquet('{p}')").fetchone()[0]==15
t=pa.table({'z':[7,8]}); assert t.column('z').to_pylist()==[7,8]
assert np.array([1,2]).sum()==3
p.unlink()
PY
jupyter kernelspec list --json | python3 -c 'import json,sys; assert "sezu-python" in json.load(sys.stdin)["kernelspecs"]'
! systemctl is-active --quiet jupyter.service 2>/dev/null
! pgrep -af '[j]upyter.*(lab|server)' >/dev/null
pass data-jupyter

convert -size 1200x320 xc:white -fill black -pointsize 54 -annotate +30+180 'SEZU OCR 314159' "$TMP/ocr.png"
/opt/sezu/packs/document-core/venv/bin/img2pdf "$TMP/ocr.png" -o "$TMP/input.pdf"
ocrmypdf --force-ocr --deskew "$TMP/input.pdf" "$TMP/output.pdf" >/dev/null 2>&1
qpdf --check "$TMP/output.pdf" >/dev/null
pdftotext "$TMP/output.pdf" - | tr -d ' ' | grep -qi 'SEZUOCR314159'
printf '# SEZU\n\nforge\n' > "$TMP/doc.md"
pandoc "$TMP/doc.md" -o "$TMP/doc.html"
libreoffice --headless --version >/dev/null
typst --version >/dev/null
inkscape --version >/dev/null
mmdc --version >/dev/null
plantuml -version >/dev/null
dot -V 2>&1 | grep -qi graphviz
exiftool -ver >/dev/null
sox --version >/dev/null
yt-dlp --version >/dev/null
ffmpeg -version >/dev/null
magick -version >/dev/null 2>&1 || convert -version >/dev/null
pass documents-ocr-media

cat > "$TMP/main.wat" <<'EOF'
(module (func (export "_start")))
EOF
wasm-tools parse "$TMP/main.wat" -o "$TMP/main.wasm"
wasm-tools print "$TMP/main.wasm" | grep -q '_start'
wasmtime "$TMP/main.wasm"
wasm-tools --version >/dev/null
wit-bindgen --version >/dev/null
wasm-pack --version >/dev/null
emcc --version >/dev/null
wasm-opt --version >/dev/null
pass webassembly

mkdir "$TMP/http"; printf 'sezu-network-ok\n' > "$TMP/http/index.html"
python3 -m http.server 18888 --bind 127.0.0.1 --directory "$TMP/http" >"$TMP/http.log" 2>&1 & http_pid=$!
for _ in $(seq 1 20); do curl -fsS http://127.0.0.1:18888/ | grep -q sezu-network-ok && break; sleep .2; done
http --check-status --ignore-stdin GET http://127.0.0.1:18888/ | grep -q sezu-network-ok
kill "$http_pid"; wait "$http_pid" 2>/dev/null || true; unset http_pid
tshark --version | head -n1 >/dev/null
/opt/sezu/packs/data-core/venv/bin/python -c 'from scapy.all import IP,TCP; assert IP(dst="127.0.0.1").dst=="127.0.0.1"'
grpcurl --version >/dev/null
websocat --version >/dev/null
iperf3 --version >/dev/null
mosquitto_pub --help >"$TMP/mosquitto-help" 2>&1 || true
grep -q 'mosquitto_pub' "$TMP/mosquitto-help"
nats --version >/dev/null
wg --version >/dev/null
socat -V 2>&1 | head -n1 >/dev/null
pass network-protocols

qemu-img create -q -f qcow2 "$TMP/test.qcow2" 16M
qemu-img info --output=json "$TMP/test.qcow2" | python3 -c 'import json,sys; x=json.load(sys.stdin); assert x["format"]=="qcow2" and x["virtual-size"]==16777216'
packer version >/dev/null
cloud-localds --version >/dev/null 2>&1 || cloud-localds -h >/dev/null 2>&1
xorriso -version >/dev/null 2>&1
test -r /dev/kvm && test -w /dev/kvm
qemu-system-x86_64 -accel kvm -machine none -nodefaults -display none -serial none -monitor none -S & qemu_pid=$!
sleep 1
kill -0 "$qemu_pid"
kill "$qemu_pid"; wait "$qemu_pid" 2>/dev/null || true; unset qemu_pid
pass machine-images-kvm

aarch64-linux-gnu-gcc -static "$TMP/hello.c" -o "$TMP/hello-aarch64"
riscv64-linux-gnu-gcc -static "$TMP/hello.c" -o "$TMP/hello-riscv64"
x86_64-w64-mingw32-gcc "$TMP/hello.c" -o "$TMP/hello.exe"
file "$TMP/hello-aarch64" | grep -q 'ARM aarch64'
file "$TMP/hello-riscv64" | grep -q 'RISC-V'
file "$TMP/hello.exe" | grep -q 'PE32+'
qemu-aarch64-static "$TMP/hello-aarch64" | grep -q sezu-native-ok
qemu-riscv64-static "$TMP/hello-riscv64" | grep -q sezu-native-ok
pass cross-build

cat > "$TMP/playwright.cjs" <<'JS'
const {chromium}=require('/opt/sezu/packs/sezu-core/node/node_modules/playwright');
(async()=>{const b=await chromium.launch({headless:true,executablePath:process.env.SEZU_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});const p=await b.newPage();await p.setContent('<title>SEZU Chromium</title><h1 id="x">forge</h1><script>document.querySelector("#x").textContent+="-js"</script>');if(await p.title()!=='SEZU Chromium')throw Error('title');if(await p.textContent('#x')!=='forge-js')throw Error('js');await p.screenshot({path:process.argv[2]});await p.pdf({path:process.argv[3]});await b.close();})();
JS
node "$TMP/playwright.cjs" "$TMP/chromium.png" "$TMP/chromium.pdf"
test -s "$TMP/chromium.png" && test -s "$TMP/chromium.pdf"
test "$(find /opt/sezu/toolchains/playwright -type f -name chrome | wc -l)" -eq 1
sezu-chromium --version | grep -F '151.0.7922.34'
node -e "if(require('/opt/sezu/packs/sezu-core/node/node_modules/playwright/package.json').version!=='1.62.1')process.exit(1)"
pass playwright-chromium

python3 - <<'PY'
import json
pack_index=json.load(open('/opt/sezu/locks/0.1.0/pack-cache-index.json'))
assert len(pack_index['base_packs'])==7
assert len(pack_index['on_demand_packs'])==25
idx=json.load(open('/cache/sezu/sources/apt/locked-index.json')); assert len(idx)==1733
idx=json.load(open('/cache/sezu/sources/direct/locked-index.json')); assert len(idx)==35
idx=json.load(open('/cache/sezu/sources/python/locked-index.json')); assert len(idx)==298
idx=json.load(open('/cache/sezu/sources/playwright/locked-index.json')); assert len(idx)==1
with open('/opt/sezu/locks/0.1.0/base-apt-installed.tsv') as f: apt=sum(1 for _ in f)-1
assert apt==1489,apt
lock=json.load(open('/opt/sezu/packs/sezu-core/node/package-lock.json')); assert len(lock['packages'])-1==466
assert set(pack_index['base_packs'])=={'sezu-core','data-core','document-core','wasm-core','network-core','machine-image-core','cross-build-core'}
PY
pass pack-cache-locks

for unit in jupyter.service postgresql.service mariadb.service mysql.service redis-server.service mongod.service clickhouse-server.service rabbitmq-server.service nats-server.service redpanda.service minio.service registry.service nginx.service apache2.service caddy.service kubelet.service; do
  ! systemctl is-active --quiet "$unit" 2>/dev/null
  ! systemctl is-enabled --quiet "$unit" 2>/dev/null || case "$unit" in docker.service|containerd.service) true;; *) false;; esac
done
for unit in sezu-supervisor.service sezu-tunnel.service; do ! systemctl list-unit-files "$unit" --no-legend 2>/dev/null | grep -q .; done
for cmd in blender ghidraRun spark-submit aws az gcloud wrangler swift dotnet bun deno julia R pwsh flutter adb fastboot ollama; do ! command -v "$cmd" >/dev/null 2>&1; done
! find /opt/sezu/toolchains/playwright -iname '*firefox*' -o -iname '*webkit*' | grep -q .
pass omissions-services

printf 'phase3 inside check passed for %s\n' "${expected_name:-instance}"
