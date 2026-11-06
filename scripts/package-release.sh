#!/usr/bin/env bash
# Package the committed source as a release tarball plus a latest.json manifest for deploy.sh's archive update source.
#
#   bash scripts/package-release.sh [OUT_DIR] [BASE_URL]
#
# Upload both files to any static host (nginx, OSS, S3, GitHub Releases...), then install with
#   sudo bash deploy.sh install --manifest https://host/path/latest.json
# BASE_URL is optional: without it the manifest references the tarball relative to latest.json.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$(mkdir -p "${1:-$ROOT/release}" && cd "${1:-$ROOT/release}" && pwd)"
BASE_URL="${2:-}"

cd "$ROOT"
git rev-parse --git-dir >/dev/null 2>&1 || { echo "需要在 git 仓库中运行" >&2; exit 1; }
[ -z "$(git status --porcelain -- . ':!release')" ] || echo "警告：存在未提交的修改，发布包只包含已提交内容" >&2

commit="$(git rev-parse HEAD)"
base_version="$(node -p "require('./package.json').version")"
version="$base_version+${commit:0:7}"
name="roadshow-studio-$base_version-${commit:0:7}.tar.gz"

git archive --format=tar.gz --prefix=roadshow-studio/ -o "$OUT/$name" HEAD
sha="$(sha256sum "$OUT/$name" | cut -d' ' -f1)"
url="${BASE_URL:+${BASE_URL%/}/}$name"

cat > "$OUT/latest.json" <<EOF
{
  "version": "$version",
  "commit": "$commit",
  "url": "$url",
  "sha256": "$sha",
  "publishedAt": "$(date -u +%FT%TZ)"
}
EOF

echo "发布包：$OUT/$name"
echo "清单：  $OUT/latest.json（version $version）"
