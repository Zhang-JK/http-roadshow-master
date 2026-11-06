#!/usr/bin/env bash
# Package an already-built tree together with a Node.js runtime into a self-contained release, so servers
# install it without npm and without downloading Node.js (used by .github/workflows/release.yml).
#
#   bash scripts/package-prebuilt.sh ARCH OUT_DIR [BASE_URL]      # ARCH: x64 | arm64
#
# Expects server/dist, production-only server/node_modules (npm prune --omit=dev) and web/dist.
# Produces roadshow-studio-<version>-linux-<ARCH>.tar.gz and latest-linux-<ARCH>.json (deploy.sh archive manifest).
# NODE_DIST (default https://nodejs.org/dist) and NODE_MAJOR (default 22) select the bundled runtime.
set -euo pipefail

ARCH="${1:?usage: package-prebuilt.sh x64|arm64 OUT_DIR [BASE_URL]}"
case "$ARCH" in x64|arm64) ;; *) echo "ARCH must be x64 or arm64" >&2; exit 2 ;; esac
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="$(mkdir -p "${2:-$ROOT/release}" && cd "${2:-$ROOT/release}" && pwd)"
BASE_URL="${3:-}"
NODE_MAJOR="${NODE_MAJOR:-22}"
NODE_DIST="${NODE_DIST:-https://nodejs.org/dist}"

cd "$ROOT"
for f in server/dist/main.js server/node_modules/better-sqlite3/package.json web/dist/index.html; do
  [ -e "$f" ] || { echo "missing $f: build first (server: npm ci && tsc -p . && npm prune --omit=dev; web: npm ci && npm run build)" >&2; exit 1; }
done
[ ! -d server/node_modules/typescript ] || { echo "server/node_modules still has dev dependencies: run npm prune --omit=dev" >&2; exit 1; }

commit="${GITHUB_SHA:-$(git rev-parse HEAD)}"
base_version="$(node -p "require('./package.json').version")"
version="$base_version+${commit:0:7}"
name="roadshow-studio-$base_version-${commit:0:7}-linux-$ARCH.tar.gz"

stage="$(mktemp -d)"; trap 'rm -rf "$stage"' EXIT
app="$stage/roadshow-studio"
mkdir -p "$app/server" "$app/web" "$app/node"
cp deploy.sh deploy_from_action.sh package.json README.md "$app/"
cp -a server/dist server/node_modules server/package.json server/package-lock.json server/scripts "$app/server/"
cp -a web/dist web/package.json "$app/web/"
# SQLite sources are only needed to compile better-sqlite3; its prebuilds/ ship the binaries.
rm -rf "$app/server/node_modules/better-sqlite3/deps" "$app/server/node_modules/better-sqlite3/src"

curl -fsSL "$NODE_DIST/latest-v$NODE_MAJOR.x/SHASUMS256.txt" -o "$stage/SHASUMS256.txt"
node_file="$(grep -oE "node-v$NODE_MAJOR\.[0-9]+\.[0-9]+-linux-$ARCH\.tar\.xz" "$stage/SHASUMS256.txt" | head -1)"
[ -n "$node_file" ] || { echo "no Node.js $NODE_MAJOR build for linux-$ARCH" >&2; exit 1; }
curl -fsSL "$NODE_DIST/latest-v$NODE_MAJOR.x/$node_file" -o "$stage/$node_file"
(cd "$stage" && grep " $node_file\$" SHASUMS256.txt | sha256sum -c - >/dev/null)
tar -xJf "$stage/$node_file" -C "$app/node" --strip-components=1
rm -rf "$app/node/include" "$app/node/share" "$app/node/lib/node_modules/corepack" "$app/node/bin/corepack"

echo "linux-$ARCH" > "$app/PREBUILT"
cat > "$app/VERSION.json" <<EOF
{"version":"$version","commit":"$commit","source":"prebuilt","ref":"linux-$ARCH","builtAt":"$(date -u +%FT%TZ)"}
EOF

tar -C "$stage" --owner=0 --group=0 --numeric-owner -czf "$OUT/$name" roadshow-studio
sha="$(sha256sum "$OUT/$name" | cut -d' ' -f1)"
cat > "$OUT/latest-linux-$ARCH.json" <<EOF
{
  "version": "$version",
  "commit": "$commit",
  "arch": "linux-$ARCH",
  "node": "$(echo "$node_file" | sed -E 's/^node-(v[0-9.]+)-.*/\1/')",
  "url": "${BASE_URL:+${BASE_URL%/}/}$name",
  "sha256": "$sha",
  "publishedAt": "$(date -u +%FT%TZ)"
}
EOF
echo "$OUT/$name ($(du -h "$OUT/$name" | cut -f1)), manifest $OUT/latest-linux-$ARCH.json, version $version"
