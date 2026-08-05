#!/bin/bash
set -euo pipefail
component=${1:?component required}
version=${2:?version required}
lock_ref=${3:?lock_ref required}
lock=${SEZU_DIRECT_LOCK:-/opt/sezu/current/locks/direct-artifacts.tsv}
[ -r "$lock" ] || lock=/opt/sezu/locks/0.1.0/direct-artifacts.tsv
row=$(awk -F '\t' -v c="$component" -v v="$version" 'NR>1 && $1==c && $2==v {print; exit}' "$lock")
[ -n "$row" ] || { echo "locked component not found: $component $version" >&2; exit 2; }
IFS=$'\t' read -r _ _ architecture source_type source_url size digest pack git_repository git_tag git_commit spdx <<<"$row"
case "$lock_ref" in component="$component"*) ;; *) echo "lock_ref does not select $component" >&2; exit 2;; esac
artifact=$(find /cache/sezu/sources /var/cache/sezu/sources -type f \( -name "${digest}-*" -o -name "*${component}*${version}*" \) -print -quit 2>/dev/null)
[ -n "$artifact" ] || { echo "cached locked artifact unavailable: $component $version" >&2; exit 3; }
printf '%s  %s\n' "$digest" "$artifact" | sha256sum -c -
root=/opt/sezu/toolchains/$component/$version
stage=${root}.stage.$$
rm -rf "$stage"
mkdir -p "$stage"
case "$artifact" in
  *.zip) unzip -q "$artifact" -d "$stage" ;;
  *.tar.gz|*.tgz) tar -xzf "$artifact" -C "$stage" ;;
  *.tar.xz) tar -xJf "$artifact" -C "$stage" ;;
  *.tar.zst) tar --zstd -xf "$artifact" -C "$stage" ;;
  *) install -m 0755 "$artifact" "$stage/$component" ;;
esac
shopt -s dotglob nullglob
entries=("$stage"/*)
if [ "${#entries[@]}" -eq 1 ] && [ -d "${entries[0]}" ]; then
  flat=${stage}.flat
  mkdir -p "$flat"
  mv "${entries[0]}"/* "$flat"/
  rm -rf "$stage"
  mv "$flat" "$stage"
fi
rm -rf "$root"
mv "$stage" "$root"
if [ "$component" = binwalk ] && [ "$version" = 3.1.0 ]; then
  crate=$(find /cache/sezu/package-managers/cargo/registry/src -path '*/yeslogic-fontconfig-sys-6.0.0/src/lib.rs' -print -quit)
  [ -n "$crate" ] || { echo "locked yeslogic-fontconfig-sys 6.0.0 source is unavailable" >&2; exit 4; }
  crate=${crate%/src/lib.rs}
  python3 - "$root" "$crate" <<'PY'
from pathlib import Path
import re
import shutil
import sys

root = Path(sys.argv[1])
crate = Path(sys.argv[2])
patch = root / '.sezu-patches' / 'yeslogic-fontconfig-sys-6.0.0'
shutil.copytree(crate, patch)

lib = patch / 'src' / 'lib.rs'
text = lib.read_text(encoding='utf-8')
text, count = re.subn(
    r'c"([^"\\]*)"',
    lambda match: 'unsafe { CStr::from_bytes_with_nul_unchecked(b"' + match.group(1) + '\\0") }',
    text,
)
if count != 58:
    raise SystemExit(f'expected 58 locked C-string compatibility rewrites, got {count}')
lib.write_text(text, encoding='utf-8')

manifest = root / 'Cargo.toml'
text = manifest.read_text(encoding='utf-8')
patch_block = '\n[patch.crates-io]\nyeslogic-fontconfig-sys = { path = ".sezu-patches/yeslogic-fontconfig-sys-6.0.0" }\n'
if '[patch.crates-io]' in text:
    raise SystemExit('unexpected existing Cargo patch section')
manifest.write_text(text.rstrip() + '\n' + patch_block, encoding='utf-8')

lock = root / 'Cargo.lock'
lines = lock.read_text(encoding='utf-8').splitlines()
out = []
target = False
removed = []
for line in lines:
    if line == '[[package]]':
        target = False
    elif line == 'name = "yeslogic-fontconfig-sys"':
        target = True
    if target and (line.startswith('source = ') or line.startswith('checksum = ')):
        removed.append(line)
        continue
    out.append(line)
expected = [
    'source = "registry+https://github.com/rust-lang/crates.io-index"',
    'checksum = "503a066b4c037c440169d995b869046827dbc71263f6e8f3be6d77d4f3229dbd"',
]
if removed != expected:
    raise SystemExit(f'unexpected locked crate metadata: {removed!r}')
lock.write_text('\n'.join(out) + '\n', encoding='utf-8')

common = root / 'src' / 'common.rs'
text = common.read_text(encoding='utf-8')
anchor = 'use std::io::Read;\n'
helper = '''use std::io::Read;\nuse std::path::{Path, PathBuf};\n\n/// Stable equivalent of std::path::absolute for the locked Rust 1.75 toolchain.\npub fn absolute_path(path: impl AsRef<Path>) -> Result<PathBuf, std::io::Error> {\n    let path = path.as_ref();\n    if path.is_absolute() {\n        Ok(path.to_path_buf())\n    } else {\n        Ok(std::env::current_dir()?.join(path))\n    }\n}\n'''
if anchor not in text or 'pub fn absolute_path' in text:
    raise SystemExit('unexpected Binwalk common.rs layout')
common.write_text(text.replace(anchor, helper, 1), encoding='utf-8')

binwalk = root / 'src' / 'binwalk.rs'
text = binwalk.read_text(encoding='utf-8')
if text.count('path::absolute') != 2:
    raise SystemExit('unexpected Binwalk primary absolute-path call count')
text = text.replace('use crate::common::{is_offset_safe, read_file};', 'use crate::common::{absolute_path, is_offset_safe, read_file};', 1)
text = text.replace('path::absolute', 'absolute_path')
binwalk.write_text(text, encoding='utf-8')

extractor = root / 'src' / 'extractors' / 'common.rs'
text = extractor.read_text(encoding='utf-8')
if text.count('path::absolute') != 1:
    raise SystemExit('unexpected Binwalk extractor absolute-path call count')
extractor.write_text('use crate::common::absolute_path;\n' + text.replace('path::absolute', 'absolute_path'), encoding='utf-8')
PY
  CARGO_HOME=/cache/sezu/package-managers/cargo cargo build \
    --manifest-path "$root/Cargo.toml" --locked --offline --release --ignore-rust-version
fi
candidate=$(find "$root" -maxdepth 4 -type f -perm /111 \( -name "$component" -o -name "$component.exe" \) -print -quit)
if [ -n "$candidate" ]; then
  ln -sfn "$candidate" "/usr/local/bin/$component"
fi
printf '{"component":"%s","version":"%s","sha256":"%s","installed_at":"%s"}\n' "$component" "$version" "$digest" "$(date --iso-8601=seconds)" > "$root/.sezu-installed.json"
