#!/bin/bash
set -euo pipefail
component=${1:?component required}
version=${2:?version required}
lock_ref=${3:?lock_ref required}
lock=/opt/sezu/current/locks/direct-artifacts.tsv
row=$(awk -F '\t' -v c="$component" -v v="$version" 'NR>1 && $1==c && $2==v {print; exit}' "$lock")
[ -n "$row" ] || { echo "locked component not found: $component $version" >&2; exit 2; }
IFS=$'\t' read -r _ _ architecture source_type source_url size digest pack git_repository git_tag git_commit spdx <<<"$row"
case "$lock_ref" in component="$component"*) ;; *) echo "lock_ref does not select $component" >&2; exit 2;; esac
artifact=$(find /cache/sezu/sources /var/cache/sezu/sources -type f \( -name "${digest}-*" -o -name "*${component}*${version}*" \) -print 2>/dev/null | head -1)
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
rm -rf "$root"
mv "$stage" "$root"
printf '{"component":"%s","version":"%s","sha256":"%s","installed_at":"%s"}\n' "$component" "$version" "$digest" "$(date --iso-8601=seconds)" > "$root/.sezu-installed.json"
