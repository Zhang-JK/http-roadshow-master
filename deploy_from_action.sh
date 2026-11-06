#!/usr/bin/env bash
# Install or update Roadshow Studio from the prebuilt packages published by GitHub Actions.
# The package already contains the compiled app, its node_modules and a Node.js runtime: nothing is
# installed from npm and Node.js is not downloaded. Later updates (command line or the web page) use the
# same GitHub releases.
#
#   sudo bash deploy_from_action.sh [options]                  # install, or update an existing installation
#   sudo bash deploy_from_action.sh --file roadshow-studio-…-linux-x64.tar.gz   # offline: a package downloaded by hand
#
# Options:
#   --repo OWNER/NAME     GitHub repository (default Zhang-JK/http-roadshow-master, or $RS_REPO)
#   --tag TAG             a specific release instead of the latest one
#   --file PATH           install a package file you downloaded yourself (from the release page)
#   --manifest URL        a mirror of latest-linux-<arch>.json (e.g. an internal server hosting the release files)
#   --proxy URL|none      HTTP(S) proxy; default: https_proxy/http_proxy (also read through sudo)
#   --ca-cert FILE|auto   trust the company root certificate (auto: take it from the proxy's certificate chain)
#   --insecure            skip HTTPS certificate checks
# Any other option (--port, --base, --user, --no-systemd, --admin-password, ...) is passed to deploy.sh.
set -Eeuo pipefail

REPO="${RS_REPO:-Zhang-JK/http-roadshow-master}"; TAG=latest; FILE=""; MANIFEST=""
PROXY=""; CA=""; INSECURE=0; BASE=/opt/roadshow-studio
PASS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO="$2"; shift ;;
    --tag) TAG="$2"; shift ;;
    --file) FILE="$(readlink -f "$2")"; shift ;;
    --manifest) MANIFEST="$2"; shift ;;
    --proxy) PROXY="$2"; PASS+=("$1" "$2"); shift ;;
    --ca-cert) CA="$2"; shift ;;
    --insecure) INSECURE=1; PASS+=("$1") ;;
    --base) BASE="$2"; PASS+=("$1" "$2"); shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    --*) if [ $# -gt 1 ] && [ "${2#--}" = "$2" ]; then PASS+=("$1" "$2"); shift; else PASS+=("$1"); fi ;;
    *) PASS+=("$1") ;;
  esac
  shift
done

c_ok=$'\033[32m'; c_err=$'\033[31m'; c_info=$'\033[36m'; c_off=$'\033[0m'
[ -t 1 ] || { c_ok=''; c_err=''; c_info=''; c_off=''; }
log() { printf '%s[%s]%s %s\n' "$c_info" "$(date '+%F %T')" "$c_off" "$*"; }
ok()  { printf '%s[%s] ✔ %s%s\n' "$c_ok" "$(date '+%F %T')" "$*" "$c_off"; }
die() { printf '%s[%s] ✘ %s%s\n' "$c_err" "$(date '+%F %T')" "$*" "$c_off" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(uname -s)" = Linux ] || die "仅支持 Linux"
case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "没有适用于 $(uname -m) 的预编译包" ;; esac
have curl || [ -n "$FILE" ] || die "需要 curl（或用 --file 指定已下载的安装包）"
have tar || die "需要 tar"

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
chmod 755 "$WORK"   # deploy.sh re-runs itself as the service user from here

# sudo's env_reset drops proxy variables; the sudo process itself still has the caller's environment.
if [ -z "$PROXY" ] && [ -z "${https_proxy:-}${HTTPS_PROXY:-}${http_proxy:-}${HTTP_PROXY:-}" ] && [ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ]; then
  pid=$PPID
  for _ in 1 2 3 4 5 6; do
    [ -r "/proc/$pid/comm" ] || break
    if [ "$(cat "/proc/$pid/comm")" = sudo ]; then
      while IFS= read -r kv; do export "${kv?}"; done < <(tr '\0' '\n' < "/proc/$pid/environ" | grep -E '^(https?_proxy|HTTPS?_PROXY|no_proxy|NO_PROXY)=' || true)
      break
    fi
    pid="$(awk '/^PPid:/ {print $2}' "/proc/$pid/status" 2>/dev/null)"; [ -n "$pid" ] && [ "$pid" -gt 1 ] || break
  done
fi
CURL=(curl -fL --connect-timeout 15)
if [ "$PROXY" = none ]; then CURL+=(--noproxy '*')
elif [ -n "$PROXY" ]; then CURL+=(-x "$PROXY")
fi
EFFECTIVE_PROXY="${PROXY:-${https_proxy:-${HTTPS_PROXY:-${http_proxy:-${HTTP_PROXY:-}}}}}"
[ "$EFFECTIVE_PROXY" = none ] && EFFECTIVE_PROXY=""

system_bundle() {
  local f
  for f in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/ca-bundle.pem /etc/ssl/cert.pem; do
    [ -f "$f" ] && { echo "$f"; return 0; }
  done
}

# --ca-cert auto: the top certificate of the chain the proxy presents for github.com.
fetch_auto_ca() {
  have openssl || die "--ca-cert auto 需要 openssl"
  local args=() hp chain="$WORK/chain"
  if [ -n "$EFFECTIVE_PROXY" ]; then
    hp="${EFFECTIVE_PROXY#*://}"; hp="${hp##*@}"; hp="${hp%%/*}"; case "$hp" in *:*) ;; *) hp="$hp:80" ;; esac
    args=(-proxy "$hp")
  fi
  mkdir -p "$chain"
  openssl s_client -showcerts -servername github.com -connect github.com:443 ${args[@]+"${args[@]}"} </dev/null 2>/dev/null \
    | awk -v d="$chain" '/-----BEGIN CERTIFICATE-----/ {n++} n {print > (d "/" n ".pem")} /-----END CERTIFICATE-----/ {close(d "/" n ".pem")}'
  local last; last="$(find "$chain" -name '*.pem' | sort -V | tail -1)"
  [ -n "$last" ] || die "无法从代理获取证书链，请改用 --ca-cert 公司根证书文件 或 --insecure"
  if [ "$(openssl x509 -in "$last" -noout -subject | sed 's/^subject=//')" != "$(openssl x509 -in "$last" -noout -issuer | sed 's/^issuer=//')" ]; then
    die "代理只返回了服务器证书，没有根证书（签发者：$(openssl x509 -in "$last" -noout -issuer | sed 's/^issuer=//')）。请向 IT 索取公司根证书并用 --ca-cert 文件 指定，或用 --insecure"
  fi
  cp "$last" "$WORK/proxy-ca.pem"
  ok "已从代理获取根证书：$(openssl x509 -in "$last" -noout -subject -fingerprint -sha256 | tr '\n' ' ')"
  printf '%s\n' "  请向 IT 核对上面的 SHA256 指纹，确认它是公司代理的根证书"
  CA="$WORK/proxy-ca.pem"
}

if [ "$INSECURE" = 1 ]; then CURL+=(-k)
elif [ -n "$CA" ] && [ "$CA" != none ]; then
  [ "$CA" = auto ] && fetch_auto_ca
  [ -f "$CA" ] || die "证书文件不存在：$CA"
  CA="$(readlink -f "$CA")"
  bundle="$WORK/ca-bundle.pem"
  { b="$(system_bundle)"; [ -n "$b" ] && cat "$b"
    if grep -q 'BEGIN CERTIFICATE' "$CA"; then cat "$CA"; else openssl x509 -inform DER -in "$CA"; fi; } > "$bundle" \
    || die "无法读取证书 $CA（需要 PEM 或 DER 格式）"
  CURL+=(--cacert "$bundle")
  PASS+=(--ca-cert "$CA")
fi

explain() { # curl exit code, stderr file
  local last; last="$(grep -v '^$' "$2" | tail -1 | sed 's/^curl: ([0-9]*) //')"
  case "$1" in
    5) echo "无法解析代理服务器地址" ;;
    6) if [ -n "$EFFECTIVE_PROXY" ]; then echo "无法解析域名：$last"; else echo "无法解析域名（公司网络通常需经代理上网：export https_proxy=http://代理:端口 或 --proxy）"; fi ;;
    7) echo "无法建立连接（代理不可用，或需要经代理上网：--proxy http://代理:端口）：$last" ;;
    28) echo "连接超时（可能需要经代理上网，或代理响应过慢）" ;;
    22) case "$last" in
          *404*) echo "没有找到发布包（HTTP 404）：仓库 $REPO 可能还没有成功运行过 GitHub Actions 发布流程，或 --tag 不存在" ;;
          *407*) echo "代理要求身份认证（HTTP 407）：--proxy http://用户名:密码@代理:端口" ;;
          *403*) echo "被拒绝（HTTP 403）：公司代理可能拦截了 GitHub 下载（github.com 与 release-assets.githubusercontent.com）。可在能上网的电脑上从发布页下载安装包，再用 --file 安装" ;;
          *) echo "服务器返回错误：$last" ;;
        esac ;;
    35|51|58|60|77|83|90|91) echo "HTTPS 证书校验失败（公司代理通常会用自己的证书重新签名）：请用 --ca-cert 公司根证书.pem 或 --ca-cert auto，无法获得证书时可用 --insecure" ;;
    56|52) if grep -q 407 "$2"; then echo "代理要求身份认证（HTTP 407）：--proxy http://用户名:密码@代理:端口"; else echo "连接被代理或服务器中断：$last"; fi ;;
    *) echo "curl 错误 $1：$last" ;;
  esac
}

field() { sed -nE "s/^[[:space:]]*\"$1\":[[:space:]]*\"([^\"]*)\".*/\1/p" "$2" | head -1; }

if [ "$TAG" = latest ]; then MANIFEST_URL="https://github.com/$REPO/releases/latest/download/latest-linux-$ARCH.json"
else MANIFEST_URL="https://github.com/$REPO/releases/download/$TAG/latest-linux-$ARCH.json"; fi
[ -n "$MANIFEST" ] && MANIFEST_URL="$MANIFEST"

if [ -n "$FILE" ]; then
  [ -f "$FILE" ] || die "安装包不存在：$FILE"
  PKG="$FILE"
  log "使用本地安装包：$FILE"
else
  log "连接测试：发布清单 $MANIFEST_URL（${EFFECTIVE_PROXY:+经代理 $(printf '%s' "$EFFECTIVE_PROXY" | sed -E 's#(://)[^/@]+@#\1***@#')}${EFFECTIVE_PROXY:-直连}）"
  rc=0; "${CURL[@]}" -sS --max-time 60 -o "$WORK/manifest.json" "$MANIFEST_URL" 2>"$WORK/err" || rc=$?
  [ "$rc" = 0 ] || die "无法获取发布清单 $MANIFEST_URL：$(explain "$rc" "$WORK/err")"
  version="$(field version "$WORK/manifest.json")"; url="$(field url "$WORK/manifest.json")"; sha="$(field sha256 "$WORK/manifest.json")"
  [ -n "$url" ] && [ -n "$sha" ] || die "发布清单格式不正确：$MANIFEST_URL"
  case "$url" in http://*|https://*) ;; *) url="${MANIFEST_URL%/*}/$url" ;; esac
  ok "最新预编译版本：$version（linux-$ARCH）"
  log "下载安装包：$url"
  PKG="$WORK/$(basename "$url")"
  rc=0; "${CURL[@]}" -S --retry 2 --progress-bar -o "$PKG" "$url" 2>"$WORK/err" || rc=$?
  [ "$rc" = 0 ] || die "安装包下载失败：$(explain "$rc" "$WORK/err")"
  echo "$sha  $PKG" | sha256sum -c - >/dev/null || die "安装包 SHA256 校验失败（下载被代理替换或截断）"
  ok "安装包校验通过（$(du -h "$PKG" | cut -f1)）"
fi
chmod 644 "$PKG"

tar -xzf "$PKG" -C "$WORK"
APP="$WORK/roadshow-studio"
[ -f "$APP/PREBUILT" ] && [ -f "$APP/deploy.sh" ] || die "这不是预编译安装包：$PKG"
[ "$(cat "$APP/PREBUILT")" = "linux-$ARCH" ] || die "安装包适用于 $(cat "$APP/PREBUILT")，本机是 linux-$ARCH"

if [ -f "$(readlink -m "$BASE")/shared/deploy.conf" ]; then CMD=update; EXTRA=(--yes); else CMD=install; EXTRA=(); fi
log "执行 deploy.sh $CMD（预编译模式：不安装 npm 依赖，不下载 Node.js）"
rc=0
bash "$APP/deploy.sh" "$CMD" --source archive --manifest "$MANIFEST_URL" --prebuilt --from "$PKG" ${EXTRA[@]+"${EXTRA[@]}"} ${PASS[@]+"${PASS[@]}"} || rc=$?
exit "$rc"
