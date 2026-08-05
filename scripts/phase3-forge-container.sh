#!/usr/bin/env bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/sezu-build/repo
CACHE=/cache/sezu
STATE=/var/lib/sezu-phase3
mkdir -p "$STATE"

stage_done() { test -f "$STATE/$1.done"; }
mark_done() { touch "$STATE/$1.done"; sync; }
log() { printf '\n[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

prerequisites() {
  log prerequisites
  grep -q '^VERSION_ID="24.04"' /etc/os-release
  test "$(uname -m)" = x86_64
  test "$(ps -p 1 -o comm=)" = systemd
  mountpoint -q /work
  mountpoint -q /cache
  test -w /work && test -w /cache
  ip -4 address show dev eth0 | grep -q '10\.177\.0\.'
  ip -6 address show dev eth0 | grep -q 'fd42:7365:7a75:'
  getent ahostsv4 pypi.org >/dev/null
  curl -4fsS --max-time 20 https://pypi.org/ >/dev/null
  curl -6fsS --max-time 20 https://pypi.org/ >/dev/null
  test -c /dev/kvm && test -r /dev/kvm && test -w /dev/kvm
  test -c /dev/net/tun && test -c /dev/fuse
  test -c /dev/vhost-net && test -c /dev/vhost-vsock
  mountpoint -q /sys/fs/cgroup
  test "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs
  df -B1 / /cache
  mkdir -p \
    "$CACHE/sources/apt/artifacts" "$CACHE/sources/apt/repo/pool" \
    "$CACHE/sources/direct/artifacts" "$CACHE/sources/npm" \
    "$CACHE/sources/python/artifacts" "$CACHE/sources/playwright" \
    "$CACHE/sources/images" "$CACHE/package-managers/npm" \
    "$CACHE/package-managers/uv" "$CACHE/package-managers/pip" \
    "$CACHE/package-managers/cargo" "$CACHE/package-managers/go" \
    "$CACHE/package-managers/maven" "$CACHE/package-managers/gradle" \
    "$CACHE/package-managers/conan" "$CACHE/package-managers/vcpkg"
  mkdir -p /opt/sezu/{locks/0.1.0,skills,packs,toolchains} /etc/sezu/skills /work/.sezu/{skills,macros}
}

fetch_inputs() {
  log fetch_inputs
  python3 "$REPO/scripts/phase3-locked-fetch.py" all --cache "$CACHE" --workers 12
  cp -a "$REPO/locks/apt-u.tsv" "$REPO/locks/direct-artifacts.tsv" \
    "$REPO/locks/npm-lock.json" "$REPO/locks/python-uv.lock" \
    "$REPO/locks/python-linux-amd64-artifacts.json" \
    "$REPO/locks/playwright-browsers.json" "$REPO/locks/capability-packs.json" \
    "$REPO/locks/licenses.json" "$REPO/config/capabilities.yaml" \
    "$REPO/config/forge/pack-cache-index.json" /opt/sezu/locks/0.1.0/
}

build_apt_repo() {
  log build_apt_repo
  python3 - <<'PY'
import json,os,subprocess,hashlib
from pathlib import Path
idx=json.load(open('/cache/sezu/sources/apt/locked-index.json'))
repo=Path('/cache/sezu/sources/apt/repo'); pool=repo/'pool'; pool.mkdir(parents=True,exist_ok=True)
out=[]
for r in idx:
    src=Path(r['cache_path']); name=src.name; dst=pool/name
    if not dst.exists(): os.link(src,dst)
    control=subprocess.check_output(['dpkg-deb','-f',str(src)],text=True)
    out.append(control.rstrip()+f"\nFilename: pool/{name}\nSize: {r['size']}\nSHA256: {r['sha256']}\n")
(repo/'Packages').write_text('\n'.join(out)+'\n')
PY
  gzip -n -9 -c "$CACHE/sources/apt/repo/Packages" > "$CACHE/sources/apt/repo/Packages.gz"
  cat > /etc/apt/sources.list.d/sezu-locked.list <<EOF
deb [trusted=yes] file:$CACHE/sources/apt/repo ./
EOF
}

install_apt() {
  log install_apt
  cat > /usr/sbin/policy-rc.d <<'EOF'
#!/bin/sh
exit 101
EOF
  chmod 0755 /usr/sbin/policy-rc.d
  apt_opts=(-o Dir::Etc::sourcelist=/etc/apt/sources.list.d/sezu-locked.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0)
  apt-get "${apt_opts[@]}" update
  mapfile -t specs < <(python3 - <<'PY'
import csv
with open('/opt/sezu-build/repo/config/forge/base-apt-roots.tsv',newline='') as f:
 for r in csv.DictReader(f,delimiter='\t'): print(f"{r['package']}={r['version']}")
PY
)
  apt-get "${apt_opts[@]}" install -y --allow-downgrades --no-install-recommends "${specs[@]}"
  dpkg --configure -a
  apt-get "${apt_opts[@]}" check
  rm -f /usr/sbin/policy-rc.d
  python3 - <<'PY'
import csv,subprocess
locked={}
with open('/opt/sezu-build/repo/locks/apt-u.tsv',newline='') as f:
 for r in csv.DictReader(f,delimiter='\t'): locked[(r['package'],r['architecture'],r['version'])]=r
installed=[]
out=subprocess.check_output(['dpkg-query','-W','-f=${binary:Package}\t${Architecture}\t${Version}\n'],text=True)
for line in out.splitlines():
 p,a,v=line.split('\t'); p=p.split(':',1)[0]
 if (p,a,v) in locked: installed.append((p,a,v))
with open('/opt/sezu/locks/0.1.0/base-apt-installed.tsv','w') as f:
 f.write('package\tarchitecture\tversion\n')
 for row in sorted(installed): f.write('\t'.join(row)+'\n')
roots=[]
with open('/opt/sezu-build/repo/config/forge/base-apt-roots.tsv',newline='') as f: roots=list(csv.DictReader(f,delimiter='\t'))
actual={(p,a):v for p,a,v in installed}
missing=[r for r in roots if actual.get((r['package'],r['architecture']))!=r['version']]
if missing: raise SystemExit('base APT roots mismatch: '+repr(missing[:10]))
print('base locked packages installed',len(installed))
PY
}

if ! stage_done prerequisites; then prerequisites; mark_done prerequisites; fi
if ! stage_done fetch; then fetch_inputs; mark_done fetch; fi
if ! stage_done apt_repo; then build_apt_repo; mark_done apt_repo; fi
if ! stage_done apt; then install_apt; mark_done apt; fi

cache_binwalk_cargo() {
  log cache_binwalk_cargo
  local artifact source
  artifact=$(python3 - <<'PY'
import json
for row in json.load(open('/cache/sezu/sources/direct/locked-index.json')):
    if row['component'] == 'binwalk' and row['version'] == '3.1.0':
        print(row['cache_path']); break
else:
    raise SystemExit('locked Binwalk source is missing')
PY
)
  source=$(mktemp -d /tmp/sezu-binwalk-cargo.XXXXXX)
  trap 'rm -rf "$source"' RETURN
  tar -xzf "$artifact" -C "$source" --strip-components=1
  CARGO_HOME="$CACHE/package-managers/cargo" cargo fetch --manifest-path "$source/Cargo.toml" --locked
}

if ! stage_done binwalk_cargo; then cache_binwalk_cargo; mark_done binwalk_cargo; fi

artifact_row() {
  python3 - "$1" <<'PY'
import json,sys
for r in json.load(open('/cache/sezu/sources/direct/locked-index.json')):
 if r['component']==sys.argv[1]:
  print(r['version']+'\t'+r['cache_path']); break
else: raise SystemExit('missing direct artifact '+sys.argv[1])
PY
}

link_first() {
  local target=$1 name=$2 pattern=$3 found
  found=$(find "$target" -type f -name "$pattern" -print -quit)
  test -n "$found"
  chmod 0755 "$found"
  ln -sfn "$found" "/usr/local/bin/$name"
}

install_direct() {
  log install_direct
  while IFS=$'\t' read -r component version; do
    IFS=$'\t' read -r locked_version artifact < <(artifact_row "$component")
    test "$version" = "$locked_version"
    target="/opt/sezu/toolchains/$component/$version"
    if test ! -f "$target/.installed"; then
      rm -rf "$target"; mkdir -p "$target"
      case "$artifact" in
        *.tar.gz|*.tgz|*.tar.xz) tar -xf "$artifact" -C "$target" ;;
        *.zip) unzip -q "$artifact" -d "$target" ;;
        *.deb) dpkg-deb -x "$artifact" "$target" ;;
        *) cp -a "$artifact" "$target/artifact" ;;
      esac
      touch "$target/.installed"
    fi
    case "$component" in
      nodejs)
        node_path=$(find "$target" -type f -path '*/bin/node' -print -quit); test -n "$node_path"
        bindir=$(dirname "$node_path"); chmod 0755 "$node_path"
        for n in node npm npx corepack; do test -e "$bindir/$n" && ln -sfn "$bindir/$n" "/usr/local/bin/$n"; done
        ;;
      github-cli) link_first "$target" gh gh ;;
      gitlab-cli) link_first "$target" glab glab ;;
      opentofu) link_first "$target" tofu tofu ;;
      kubectl) chmod 0755 "$target/artifact"; ln -sfn "$target/artifact" /usr/local/bin/kubectl ;;
      uv) link_first "$target" uv uv; link_first "$target" uvx uvx ;;
      typst) link_first "$target" typst typst ;;
      wasmtime) link_first "$target" wasmtime wasmtime ;;
      wasm-tools) link_first "$target" wasm-tools wasm-tools ;;
      wit-bindgen) link_first "$target" wit-bindgen wit-bindgen ;;
      wasm-pack) link_first "$target" wasm-pack wasm-pack ;;
      packer) link_first "$target" packer packer ;;
      bazel) chmod 0755 "$target/artifact"; ln -sfn "$target/artifact" /usr/local/bin/bazel ;;
      grpcurl) link_first "$target" grpcurl grpcurl ;;
      websocat) chmod 0755 "$target/artifact"; ln -sfn "$target/artifact" /usr/local/bin/websocat ;;
      nats-cli) link_first "$target" nats nats ;;
      vcpkg)
        bootstrap=$(find "$target" -type f -name bootstrap-vcpkg.sh -print -quit); test -n "$bootstrap"
        root=$(dirname "$bootstrap")
        if test ! -x "$root/vcpkg"; then VCPKG_DOWNLOADS="$CACHE/package-managers/vcpkg" "$bootstrap" -disableMetrics; fi
        ln -sfn "$root/vcpkg" /usr/local/bin/vcpkg
        ;;
      *) echo "unhandled direct component $component" >&2; exit 1 ;;
    esac
  done < <(python3 - <<'PY'
import csv
with open('/opt/sezu-build/repo/config/forge/base-direct.tsv',newline='') as f:
 for r in csv.DictReader(f,delimiter='\t'): print(r['component']+'\t'+r['version'])
PY
)
  node --version | grep -Fx v24.19.0
  uv --version
  gh --version | head -n1
  tofu version | head -n1
  wasmtime --version
  packer version
  bazel --version
}

install_npm() {
  log install_npm
  export npm_config_cache="$CACHE/package-managers/npm"
  export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1
  rm -rf /tmp/sezu-npm-all
  mkdir -p /tmp/sezu-npm-all
  cp "$REPO/locks/npm-lock.json" /tmp/sezu-npm-all/package-lock.json
  node - <<'JS'
const fs=require('fs'); const l=require('/tmp/sezu-npm-all/package-lock.json');
const r=l.packages['']; fs.writeFileSync('/tmp/sezu-npm-all/package.json',JSON.stringify({name:r.name,version:r.version,private:true,dependencies:r.dependencies},null,2)+'\n');
JS
  (cd /tmp/sezu-npm-all && npm ci --ignore-scripts --no-audit --no-fund)
  rm -rf /tmp/sezu-npm-all/node_modules
  install=/opt/sezu/packs/sezu-core/node
  rm -rf "$install"; mkdir -p "$install"
  cp "$REPO/config/forge/base-npm-package.json" "$install/package.json"
  cp "$REPO/config/forge/base-npm-lock.json" "$install/package-lock.json"
  (cd "$install" && npm ci --ignore-scripts --no-audit --no-fund)
  for n in playwright tsc tsx mmdc; do test -e "$install/node_modules/.bin/$n" && ln -sfn "$install/node_modules/.bin/$n" "/usr/local/bin/$n"; done
  node -e "const p=require('$install/node_modules/playwright/package.json'); if(p.version!=='1.62.1') process.exit(1)"
  node -e "const l=require('$install/package-lock.json');const a=require('$install/node_modules/typescript/package.json');if(a.version!==l.packages['node_modules/typescript'].version)process.exit(1)"
  rm -rf /tmp/sezu-npm-all
}

python_paths_for_env() {
  python3 - "$1" <<'PY'
import json,os,sys
from pathlib import Path
env=sys.argv[1]
idx={(x['name'],x['version']):x['cache_path'] for x in json.load(open('/cache/sezu/sources/python/locked-index.json'))}
stage=Path('/cache/sezu/sources/python/install')/env
stage.mkdir(parents=True,exist_ok=True)
for p in json.load(open('/opt/sezu-build/repo/config/forge/base-python-plan.json')):
 if p['environment']!=env: continue
 src=idx[(p['name'],p['version'])]
 dst=stage/p['filename']
 if dst.is_symlink() and os.readlink(dst)==src: pass
 else:
  if dst.exists() or dst.is_symlink(): dst.unlink()
  dst.symlink_to(src)
 print(p['kind']+'\t'+str(dst))
PY
}

install_python_env() {
  local env=$1 target=$2
  rm -rf "$target"
  python3 -m venv "$target"
  mapfile -t wheels < <(python_paths_for_env "$env" | awk -F '\t' '$1=="wheel"{print $2}')
  mapfile -t sdists < <(python_paths_for_env "$env" | awk -F '\t' '$1=="sdist"{print $2}')
  UV_CACHE_DIR="$CACHE/package-managers/uv" uv pip install --python "$target/bin/python" --no-deps --offline "${wheels[@]}"
  if ((${#sdists[@]})); then
    UV_CACHE_DIR="$CACHE/package-managers/uv" uv pip install --python "$target/bin/python" --no-deps --offline --no-build-isolation "${sdists[@]}"
  fi
  if test "$env" = data-core; then
    site=$($target/bin/python -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')
    ln -sfn /usr/lib/python3/dist-packages/osgeo "$site/osgeo"
  fi
  "$target/bin/python" -m pip check
  "$target/bin/python" -m pip freeze | LC_ALL=C sort > "/opt/sezu/locks/0.1.0/base-python-$env.txt"
}

install_python() {
  log install_python
  install_python_env data-core /opt/sezu/packs/data-core/venv
  install_python_env document-core /opt/sezu/packs/document-core/venv
  data=/opt/sezu/packs/data-core/venv/bin
  doc=/opt/sezu/packs/document-core/venv/bin
  for n in python pip jupyter jupyter-lab ipython http https mitmproxy mitmdump scapy conan dbt; do
    test -e "$data/$n" && ln -sfn "$data/$n" "/usr/local/bin/${n/python/sezu-python}"
  done
  ln -sfn "$doc/ocrmypdf" /usr/local/bin/ocrmypdf
  "$data/python" -m ipykernel install --prefix=/usr/local --name sezu-python --display-name 'SEZU Python 3.12'
  "$data/python" - <<'PY'
import numpy,scipy,pandas,polars,sklearn,pyarrow,duckdb,cv2,osgeo
print('python base imports ok')
PY
  "$doc/python" -c 'import ocrmypdf; print(ocrmypdf.__version__)' | grep -Fx 17.8.1
}

install_browser() {
  log install_browser
  artifact=$(python3 - <<'PY'
import json
print(json.load(open('/cache/sezu/sources/playwright/locked-index.json'))[0]['cache_path'])
PY
)
  target=/opt/sezu/toolchains/playwright/chromium-1234
  rm -rf "$target"; mkdir -p "$target"
  unzip -q "$artifact" -d "$target"
  chrome=$(find "$target" -type f -name chrome -print -quit); test -n "$chrome"; chmod 0755 "$chrome"
  ln -sfn "$chrome" /usr/local/bin/sezu-chromium
  printf '%s\n' "$chrome" > /opt/sezu/toolchains/playwright/chromium-path
  test "$(find /opt/sezu/toolchains/playwright -type f -name chrome | wc -l)" -eq 1
  "$chrome" --version | grep -F '151.0.7922.34'
}

configure_forge() {
  log configure_forge
  mkdir -p /etc/docker /etc/environment.d
  cat > /etc/docker/daemon.json <<'JSON'
{
  "default-address-pools": [
    {"base": "172.30.0.0/16", "size": 24}
  ]
}
JSON
  cat > /etc/profile.d/sezu-forge.sh <<'EOF'
export PATH=/usr/local/bin:/opt/sezu/packs/document-core/venv/bin:/opt/sezu/packs/data-core/venv/bin:/opt/sezu/packs/sezu-core/node/node_modules/.bin:$PATH
export PLAYWRIGHT_BROWSERS_PATH=/opt/sezu/toolchains/playwright
export SEZU_CHROMIUM_EXECUTABLE="$(cat /opt/sezu/toolchains/playwright/chromium-path)"
export PUPPETEER_EXECUTABLE_PATH="$SEZU_CHROMIUM_EXECUTABLE"
export npm_config_cache=/cache/sezu/package-managers/npm
export UV_CACHE_DIR=/cache/sezu/package-managers/uv
export PIP_CACHE_DIR=/cache/sezu/package-managers/pip
export CARGO_HOME=/cache/sezu/package-managers/cargo
export GOPATH=/cache/sezu/package-managers/go
export MAVEN_USER_HOME=/cache/sezu/package-managers/maven
export GRADLE_USER_HOME=/cache/sezu/package-managers/gradle
export CONAN_HOME=/cache/sezu/package-managers/conan
export VCPKG_DOWNLOADS=/cache/sezu/package-managers/vcpkg
EOF
  cat > /etc/environment.d/90-sezu-forge.conf <<EOF
PLAYWRIGHT_BROWSERS_PATH=/opt/sezu/toolchains/playwright
SEZU_CHROMIUM_EXECUTABLE=$(cat /opt/sezu/toolchains/playwright/chromium-path)
EOF
  systemctl daemon-reload
  systemctl enable docker.service containerd.service
  systemctl restart containerd.service
  systemctl restart docker.service
  systemctl is-active --quiet docker.service
}

if ! stage_done direct; then install_direct; mark_done direct; fi
if ! stage_done npm; then install_npm; mark_done npm; fi
if ! stage_done python; then install_python; mark_done python; fi
if ! stage_done browser; then install_browser; mark_done browser; fi
if ! stage_done configure; then configure_forge; mark_done configure; fi

if ! stage_done checks; then "$REPO/scripts/phase3-forge-inside-check.sh" u-build; mark_done checks; fi
