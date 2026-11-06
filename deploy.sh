#!/usr/bin/env bash
# Roadshow Studio — one-click deploy / update tool for Linux.
#
#   sudo bash deploy.sh                      # 一键：未安装则安装，已安装则检查并更新
#   sudo bash deploy.sh install [options]    # 安装并启动（默认端口 9090）
#   bash deploy.sh check [--json]            # 检查是否有新版本
#   bash deploy.sh update [--yes] [--force] [--from PATH]
#   bash deploy.sh rollback                  # 回滚到上一个版本（同时恢复更新前的数据库备份）
#   bash deploy.sh nettest [options]         # 只做网络连接检测（代理、证书、下载源），不安装任何东西
#   bash deploy.sh start|stop|restart|status|logs [-f]|uninstall [--purge]
#
# Install options:
#   --source git|archive|local   更新源类型（默认：有 --repo 用 git，有 --manifest 用 archive，否则 local）
#   --repo URL --branch NAME     git 仓库地址与分支（默认 main）
#   --manifest URL               发布清单 latest.json 的地址（由 scripts/package-release.sh 生成）
#   --from PATH                  从本地目录 / .zip / .tar.gz 安装或更新
#   --port N                     监听端口（默认 9090）      --host ADDR   监听地址（默认 0.0.0.0）
#   --base DIR                   安装目录（默认 /opt/roadshow-studio）
#   --user NAME                  运行服务的系统用户（root 安装时默认 roadshow）
#   --no-systemd                 不使用 systemd，改用内置守护进程
#   --admin-password PWD         首次启动时 admin 的初始密码
#   --npm-registry URL           npm 镜像（如 https://registry.npmmirror.com）
#   --node-mirror URL            Node.js 下载镜像（如 https://npmmirror.com/mirrors/node）
#
# Network options (install/update/nettest; saved and reused by later updates and by the app itself):
#   --proxy URL                  HTTP(S) 代理，如 http://proxy.corp:8080 或 http://用户:密码@proxy:8080；
#                                未指定时使用 https_proxy/http_proxy 环境变量（sudo 运行时读取调用者的），都没有则沿用上次保存的设置；
#                                --proxy none 表示不使用代理
#   --no-proxy LIST              不走代理的地址（逗号分隔，如 .corp.local,10.0.0.0/8；本机地址总是直连）
#   --ca-cert FILE|auto|none     额外信任的根证书（公司代理解密 HTTPS 时使用，PEM 或 DER）；
#                                auto = 从代理返回的证书链中取根证书并信任（会打印指纹供核对）
#   --insecure / --secure        关闭 / 恢复 HTTPS 证书校验（仅在无法获得公司根证书时使用）
#   --skip-nettest               跳过安装/更新前的网络连接检测
#   --prebuilt                   只使用 GitHub Actions 发布的预编译包（不运行 npm、不下载 Node.js；deploy_from_action.sh 自动设置）
set -Eeuo pipefail

APP_NAME="roadshow-studio"
SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(dirname "$SCRIPT_PATH")"
NODE_MAJOR=22

# ---------------------------------------------------------------- helpers
c_info=$'\033[36m'; c_ok=$'\033[32m'; c_warn=$'\033[33m'; c_err=$'\033[31m'; c_off=$'\033[0m'
[ -t 1 ] || { c_info=''; c_ok=''; c_warn=''; c_err=''; c_off=''; }
log()  { printf '%s[%s]%s %s\n' "$c_info" "$(date '+%F %T')" "$c_off" "$*"; }
ok()   { printf '%s[%s] ✔ %s%s\n' "$c_ok" "$(date '+%F %T')" "$*" "$c_off"; }
warn() { printf '%s[%s] ⚠ %s%s\n' "$c_warn" "$(date '+%F %T')" "$*" "$c_off" >&2; }
die()  {
  printf '%s[%s] ✘ %s%s\n' "$c_err" "$(date '+%F %T')" "$*" "$c_off" >&2
  set_status failed "$*" || true
  # Drop a release that failed before it was switched in.
  if [ -n "${BUILDING_REL:-}" ] && [ "$BUILDING_REL" != "$(current_release)" ]; then rm -rf "$BUILDING_REL"; fi
  exit 1
}
is_root() { [ "$(id -u)" -eq 0 ]; }
have() { command -v "$1" >/dev/null 2>&1; }

# ---------------------------------------------------------------- options
ORIG_ARGS=("$@")
CMD="${1:-auto}"; [ $# -gt 0 ] && shift
OPT_SOURCE=""; OPT_REPO=""; OPT_BRANCH=""; OPT_MANIFEST=""; OPT_FROM=""; OPT_PORT=""; OPT_HOST=""
OPT_BASE=""; OPT_USER=""; OPT_NO_SYSTEMD=0; OPT_ADMIN_PWD=""; OPT_NPM_REGISTRY=""; OPT_NODE_MIRROR=""
OPT_JSON=0; OPT_YES=0; OPT_FORCE=0; OPT_FOLLOW=0; OPT_PURGE=0
OPT_PROXY=""; OPT_NO_PROXY=""; OPT_CA_CERT=""; OPT_INSECURE=""; OPT_SKIP_NETTEST=0; OPT_PREBUILT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --source) OPT_SOURCE="$2"; shift ;;
    --repo) OPT_REPO="$2"; shift ;;
    --branch) OPT_BRANCH="$2"; shift ;;
    --manifest) OPT_MANIFEST="$2"; shift ;;
    --from) OPT_FROM="$(readlink -f "$2" 2>/dev/null || echo "$2")"; shift ;;
    --port) OPT_PORT="$2"; shift ;;
    --host) OPT_HOST="$2"; shift ;;
    --base) OPT_BASE="$2"; shift ;;
    --user) OPT_USER="$2"; shift ;;
    --no-systemd) OPT_NO_SYSTEMD=1 ;;
    --admin-password) OPT_ADMIN_PWD="$2"; shift ;;
    --npm-registry) OPT_NPM_REGISTRY="$2"; shift ;;
    --node-mirror) OPT_NODE_MIRROR="$2"; shift ;;
    --proxy) OPT_PROXY="$2"; shift ;;
    --no-proxy) OPT_NO_PROXY="$2"; shift ;;
    --ca-cert) case "$2" in auto|none) OPT_CA_CERT="$2" ;; *) OPT_CA_CERT="$(readlink -f "$2" 2>/dev/null || echo "$2")" ;; esac; shift ;;
    --insecure) OPT_INSECURE=1 ;;
    --secure) OPT_INSECURE=0 ;;
    --skip-nettest) OPT_SKIP_NETTEST=1 ;;
    --prebuilt) OPT_PREBUILT=1 ;;
    --json) OPT_JSON=1 ;;
    --yes|-y) OPT_YES=1 ;;
    --force) OPT_FORCE=1 ;;
    -f|--follow) OPT_FOLLOW=1 ;;
    --purge) OPT_PURGE=1 ;;
    -h|--help) CMD=help ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

# The installed copy lives at $BASE_DIR/deploy.sh; when run from there, that directory is the base.
if [ -n "$OPT_BASE" ]; then BASE_DIR="$(readlink -m "$OPT_BASE")"
elif [ -n "${RS_BASE_DIR:-}" ]; then BASE_DIR="$RS_BASE_DIR"
elif [ -f "$SCRIPT_DIR/shared/deploy.conf" ]; then BASE_DIR="$SCRIPT_DIR"
else BASE_DIR="/opt/$APP_NAME"; fi

# Commands often start in a directory the service user cannot enter (e.g. /root after a privilege drop).
if ! [ -r . ] || ! [ -x . ]; then cd "$BASE_DIR" 2>/dev/null || cd /; fi
SHARED="$BASE_DIR/shared"
CONF="$SHARED/deploy.conf"
APP_ENV="$SHARED/app.env"
RUN_DIR="$SHARED/run"
LOG_DIR="$SHARED/logs"
DATA_DIR="$SHARED/data"
BACKUP_DIR="$SHARED/backups"
RELEASES="$BASE_DIR/releases"
CURRENT="$BASE_DIR/current"
STATUS_FILE="$RUN_DIR/update-status.json"

# Defaults, overridden by deploy.conf, then by command-line options.
PORT=9090; HOST=0.0.0.0; UPDATE_SOURCE=local; REPO_URL=""; BRANCH=main; MANIFEST_URL=""; LOCAL_SOURCE=""
SERVICE_USER=""; USE_SYSTEMD=0; NODE_BIN=""; KEEP_RELEASES=3; NPM_REGISTRY=""; NODE_MIRROR="https://nodejs.org/dist"
ADMIN_PASSWORD=""; PROXY_URL=""; NO_PROXY_LIST=""; CA_CERT=""; TLS_INSECURE=0; PREBUILT=0; SERVICE_NAME=""
if [ -f "$CONF" ] && [ ! -r "$CONF" ]; then
  if have sudo; then exec sudo bash "$SCRIPT_PATH" "${ORIG_ARGS[@]}"; fi
  echo "无权读取 $CONF，请使用 root 或服务用户执行" >&2; exit 1
fi
# shellcheck source=/dev/null
[ -f "$CONF" ] && . "$CONF"
[ -n "$OPT_PORT" ] && PORT="$OPT_PORT"
[ -n "$OPT_HOST" ] && HOST="$OPT_HOST"
[ -n "$OPT_REPO" ] && REPO_URL="$OPT_REPO"
[ -n "$OPT_BRANCH" ] && BRANCH="$OPT_BRANCH"
[ -n "$OPT_MANIFEST" ] && MANIFEST_URL="$OPT_MANIFEST"
[ -n "$OPT_NPM_REGISTRY" ] && NPM_REGISTRY="$OPT_NPM_REGISTRY"
[ -n "$OPT_NODE_MIRROR" ] && NODE_MIRROR="$OPT_NODE_MIRROR"
[ -n "$OPT_ADMIN_PWD" ] && ADMIN_PASSWORD="$OPT_ADMIN_PWD"
[ -n "$OPT_PROXY" ] && PROXY_URL="$OPT_PROXY"
[ -n "$OPT_NO_PROXY" ] && NO_PROXY_LIST="$OPT_NO_PROXY"
[ -n "$OPT_INSECURE" ] && TLS_INSECURE="$OPT_INSECURE"
[ -n "$OPT_PREBUILT" ] && PREBUILT="$OPT_PREBUILT"
SERVICE_NAME="${SERVICE_NAME:-$APP_NAME}"
UNIT_FILE="/etc/systemd/system/$SERVICE_NAME.service"
[ "$OPT_CA_CERT" = none ] && CA_CERT=""
if [ -n "$OPT_SOURCE" ]; then UPDATE_SOURCE="$OPT_SOURCE"
elif [ -n "$OPT_REPO" ]; then UPDATE_SOURCE=git
elif [ -n "$OPT_MANIFEST" ]; then UPDATE_SOURCE=archive; fi

save_conf() {
  mkdir -p "$SHARED"
  cat > "$CONF.tmp" <<EOF
# Roadshow Studio 部署配置（由 deploy.sh 生成，可手动修改后执行 deploy.sh restart）
PORT=$(printf %q "$PORT")
HOST=$(printf %q "$HOST")
UPDATE_SOURCE=$(printf %q "$UPDATE_SOURCE")
REPO_URL=$(printf %q "$REPO_URL")
BRANCH=$(printf %q "$BRANCH")
MANIFEST_URL=$(printf %q "$MANIFEST_URL")
LOCAL_SOURCE=$(printf %q "$LOCAL_SOURCE")
SERVICE_USER=$(printf %q "$SERVICE_USER")
USE_SYSTEMD=$(printf %q "$USE_SYSTEMD")
NODE_BIN=$(printf %q "$NODE_BIN")
KEEP_RELEASES=$(printf %q "$KEEP_RELEASES")
NPM_REGISTRY=$(printf %q "$NPM_REGISTRY")
NODE_MIRROR=$(printf %q "$NODE_MIRROR")
ADMIN_PASSWORD=$(printf %q "$ADMIN_PASSWORD")
PROXY_URL=$(printf %q "$PROXY_URL")
NO_PROXY_LIST=$(printf %q "$NO_PROXY_LIST")
CA_CERT=$(printf %q "$CA_CERT")
TLS_INSECURE=$(printf %q "$TLS_INSECURE")
PREBUILT=$(printf %q "$PREBUILT")
SERVICE_NAME=$(printf %q "$SERVICE_NAME")
EOF
  mv -f "$CONF.tmp" "$CONF"
  chmod 600 "$CONF"
  own_file "$CONF"
}

# Files rewritten by root must stay readable by the service user that runs the app.
own_file() { if is_root && [ -n "$SERVICE_USER" ] && [ "$SERVICE_USER" != root ] && id "$SERVICE_USER" >/dev/null 2>&1; then chown "$SERVICE_USER": "$@"; fi; }

write_app_env() {
  cat > "$APP_ENV.tmp" <<EOF
NODE_ENV=production
PORT=$PORT
HOST=$HOST
DATA_DIR=$DATA_DIR
WEB_DIST=$CURRENT/web/dist
RS_BASE_DIR=$BASE_DIR
RS_RUN_DIR=$RUN_DIR
PLAYWRIGHT_BROWSERS_PATH=$SHARED/ms-playwright
HOME=$BASE_DIR
npm_config_cache=$SHARED/npm-cache
PATH=$(dirname "${NODE_BIN:-/usr/bin/node}"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
EOF
  [ -n "$ADMIN_PASSWORD" ] && echo "ADMIN_PASSWORD=$ADMIN_PASSWORD" >> "$APP_ENV.tmp"
  # The app calls model APIs and renders pages with web fonts, so it needs the same proxy / trust settings.
  {
    printf 'NO_PROXY=%q\nno_proxy=%q\n' "$NO_PROXY_ALL" "$NO_PROXY_ALL"
    if proxy_on && app_proxy_ok; then
      printf '%s=%q\n' HTTPS_PROXY "$PROXY_URL" HTTP_PROXY "$PROXY_URL" https_proxy "$PROXY_URL" http_proxy "$PROXY_URL"
      echo "NODE_USE_ENV_PROXY=1"
    fi
    if [ "$TLS_INSECURE" = 1 ]; then echo "NODE_TLS_REJECT_UNAUTHORIZED=0"
    elif [ -n "$CA_CERT" ]; then printf 'NODE_EXTRA_CA_CERTS=%q\n' "$CA_CERT"; fi
  } >> "$APP_ENV.tmp"
  [ -f "$SHARED/extra.env" ] && cat "$SHARED/extra.env" >> "$APP_ENV.tmp"
  mv -f "$APP_ENV.tmp" "$APP_ENV"
  chmod 600 "$APP_ENV"
  own_file "$APP_ENV"
}

as_service_user() {
  if is_root && [ -n "$SERVICE_USER" ] && [ "$SERVICE_USER" != root ]; then
    runuser -u "$SERVICE_USER" -- "$@"
  else
    "$@"
  fi
}

fix_owner() {
  if is_root && [ -n "$SERVICE_USER" ] && [ "$SERVICE_USER" != root ]; then
    chown -R "$SERVICE_USER": "$BASE_DIR"
  fi
}

json_escape() { local s="${1//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\r'/}"; s="${s//$'\t'/ }"; printf '%s' "$s"; }

STATUS_ACTIVE=0
set_status() { # state message [to-version]; only update/install/rollback runs report status
  [ "$STATUS_ACTIVE" = 1 ] && [ -d "$RUN_DIR" ] || return 0
  printf '{"state":"%s","message":"%s","to":"%s","from":"%s","updatedAt":%s}\n' \
    "$1" "$(json_escape "${2:-}")" "$(json_escape "${3:-${STATUS_TO:-}}")" "$(json_escape "${STATUS_FROM:-}")" "$(date +%s)000" \
    > "$STATUS_FILE.tmp" && mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}

lock() {
  mkdir -p "$RUN_DIR"
  exec 9>"$RUN_DIR/deploy.lock"
  flock -n 9 || die "另一个部署/更新任务正在进行中"
  STATUS_ACTIVE=1
}

start_logging() {
  mkdir -p "$LOG_DIR"
  exec > >(tee -a "$LOG_DIR/deploy.log") 2>&1
}

# ---------------------------------------------------------------- network: proxy, TLS, connection test
CERT_DIR="$SHARED/certs"
PROXY_SOURCE=""
NO_PROXY_ALL="localhost,127.0.0.1,::1"
CURL_TLS=(); APT_NET=(); DNF_NET=()
NET_FAIL=0

mask_url() { printf '%s' "$1" | sed -E 's#(://)[^/@]+@#\1***@#'; }
proxy_on() { [ -n "$PROXY_URL" ] && [ "$PROXY_URL" != none ]; }
url_host() { local u="${1#*://}"; u="${u##*@}"; u="${u%%/*}"; printf '%s' "${u%%:*}"; }
url_port() { local u="${1#*://}"; u="${u##*@}"; u="${u%%/*}"; case "$u" in *:*) printf '%s' "${u##*:}" ;; *) case "$1" in http://*) echo 80 ;; *) echo 443 ;; esac ;; esac; }
proxy_hostport() { local u="${PROXY_URL#*://}"; u="${u##*@}"; u="${u%%/*}"; case "$u" in *:*) ;; *) u="$u:80" ;; esac; printf '%s' "$u"; }
proxy_cred() { local u="${PROXY_URL#*://}"; u="${u%%/*}"; case "$u" in *@*) printf '%s' "${u%@*}" ;; esac; }

# sudo's env_reset strips proxy variables from the command, but the sudo process itself (an ancestor of
# this script, also when the script re-runs itself through sudo) still carries the caller's environment.
SUDO_ENV=""
load_sudo_env() {
  is_root && [ -n "${SUDO_USER:-}" ] || return 0
  local pid=$PPID
  for _ in 1 2 3 4 5 6; do
    [ -r "/proc/$pid/comm" ] || break
    if [ "$(cat "/proc/$pid/comm")" = sudo ]; then
      SUDO_ENV="$(tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -E '^(https?_proxy|HTTPS?_PROXY|no_proxy|NO_PROXY)=' || true)"
      [ -n "$SUDO_ENV" ] && break
    fi
    pid="$(awk '/^PPid:/ {print $2}' "/proc/$pid/status" 2>/dev/null)"
    [ -n "$pid" ] && [ "$pid" -gt 1 ] || break
  done
}
sudo_caller_env() { [ -z "$SUDO_ENV" ] || printf '%s\n' "$SUDO_ENV" | sed -n "s/^$1=//p" | head -1; }

# --proxy > https_proxy/http_proxy from the environment (including the caller's, under sudo) >
# the proxy saved in deploy.conf, which keeps updates started from the web page on the install-time proxy.
detect_proxy() {
  [ -n "$PROXY_SOURCE" ] && return 0
  if [ -n "$OPT_PROXY" ]; then PROXY_SOURCE=命令行参数; return 0; fi
  local v p from=""
  for v in https_proxy HTTPS_PROXY http_proxy HTTP_PROXY; do
    p="${!v:-}"
    [ -n "$p" ] && break
  done
  if [ -z "$p" ]; then
    load_sudo_env
    for v in https_proxy HTTPS_PROXY http_proxy HTTP_PROXY; do
      p="$(sudo_caller_env "$v")"
      [ -n "$p" ] && { from=sudo; break; }
    done
  fi
  if [ -n "$p" ] && [ "$p" != none ]; then
    PROXY_URL="$p"; PROXY_SOURCE="环境变量 $v${from:+（sudo 调用者）}"
    if [ -z "$OPT_NO_PROXY" ]; then
      local np="${no_proxy:-${NO_PROXY:-}}"
      [ -n "$np" ] || np="$(sudo_caller_env no_proxy || true)"
      [ -n "$np" ] || np="$(sudo_caller_env NO_PROXY || true)"
      np="$(printf '%s' "$np" | tr ',' '\n' | sed 's/^ *//;s/ *$//' | grep -vxE 'localhost|127\.0\.0\.1|::1|' | paste -sd, - || true)"
      [ -n "$np" ] && NO_PROXY_LIST="$np"
    fi
    return 0
  fi
  if [ -n "$PROXY_URL" ]; then PROXY_SOURCE="上次保存的设置 $CONF"; else PROXY_SOURCE=无; fi
}

system_ca_bundle() {
  local f
  for f in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/ca-bundle.pem /etc/ssl/cert.pem; do
    [ -f "$f" ] && { echo "$f"; return 0; }
  done
  return 1
}

build_ca_bundle() { # system roots + the extra CA: curl, git and npm replace (not extend) their trust store
  local sys; sys="$(system_ca_bundle || true)"
  { [ -n "$sys" ] && cat "$sys"; echo; cat "$CA_CERT"; } > "$CERT_DIR/ca-bundle.pem"
  chmod 644 "$CERT_DIR/ca-bundle.pem"
}

cert_info() { have openssl && openssl x509 -in "$1" -noout -subject -enddate -fingerprint -sha256 2>/dev/null | tr '\n' ' ' || true; }

import_ca() { # file -> trusted from now on
  local src="$1"
  [ -r "$src" ] || die "无法读取证书文件：$src"
  mkdir -p "$CERT_DIR"
  if grep -q 'BEGIN CERTIFICATE' "$src"; then cp -f "$src" "$CERT_DIR/proxy-ca.pem"
  elif have openssl && openssl x509 -inform DER -in "$src" -out "$CERT_DIR/proxy-ca.pem" 2>/dev/null; then :
  else die "不是有效的证书文件（需要 PEM 或 DER 格式）：$src"; fi
  chmod 644 "$CERT_DIR/proxy-ca.pem"
  CA_CERT="$CERT_DIR/proxy-ca.pem"
  build_ca_bundle
  ok "已信任根证书：$(cert_info "$CA_CERT")"
}

# --ca-cert auto: take the top certificate of the chain the proxy presents for a public site.
fetch_proxy_ca() {
  have openssl || die "--ca-cert auto 需要 openssl，请安装后重试，或用 --ca-cert 文件 指定证书"
  local reg="${NPM_REGISTRY:-https://registry.npmjs.org}" host port
  host="$(url_host "$reg")"; port="$(url_port "$reg")"
  if curl -sS -o /dev/null --connect-timeout 10 --max-time 20 "https://$host:$port/" 2>/dev/null; then
    ok "访问 https://$host 的证书可被系统信任，HTTPS 未被代理解密，无需导入证书"; return 0
  fi
  local args=(s_client -showcerts -servername "$host" -connect "$host:$port") cred tmp n last aia
  if proxy_on; then
    args+=(-proxy "$(proxy_hostport)")
    cred="$(proxy_cred)"; [ -n "$cred" ] && args+=(-proxy_user "${cred%%:*}" -proxy_pass "pass:${cred#*:}")
  fi
  tmp="$(mktemp -d)"
  timeout 25 openssl "${args[@]}" </dev/null >"$tmp/chain" 2>"$tmp/err" || true
  awk -v dir="$tmp" '/-----BEGIN CERTIFICATE-----/{n++; f=1} f{print > (dir "/c" n ".pem")} /-----END CERTIFICATE-----/{f=0}' "$tmp/chain"
  n="$(find "$tmp" -name 'c*.pem' | wc -l)"
  [ "$n" -gt 0 ] || die "无法从 $host 获取证书链：$(grep -v '^$' "$tmp/err" | tail -1)"
  last="$tmp/c$n.pem"
  if [ "$n" = 1 ]; then
    # Only the site certificate was sent; its "CA Issuers" URL (AIA) may point at the signing CA.
    aia="$(openssl x509 -in "$last" -noout -ext authorityInfoAccess 2>/dev/null | sed -nE 's/.*CA Issuers - URI:(https?:[^[:space:]]+).*/\1/p' | head -1)"
    if [ -n "$aia" ] && net_curl -fsSL --max-time 20 "$aia" -o "$tmp/issuer.crt" 2>/dev/null; then
      log "代理只返回了站点证书，已按其 CA Issuers 地址下载签发证书：$aia"
      last="$tmp/issuer.crt"
    else
      die "代理只返回了站点证书（签发者：$(openssl x509 -in "$last" -noout -issuer 2>/dev/null | sed 's/^issuer=//')），无法自动获得其根证书。请向 IT 索取公司根证书后用 --ca-cert 文件 指定（也可从已信任该代理的电脑上导出浏览器中的根证书），或使用 --insecure"
    fi
  fi
  if [ "$n" -gt 1 ] && [ "$(openssl x509 -in "$last" -noout -subject 2>/dev/null | sed 's/^subject=//')" != "$(openssl x509 -in "$last" -noout -issuer 2>/dev/null | sed 's/^issuer=//')" ]; then
    warn "代理返回的最上层证书不是自签名根证书，若仍校验失败请向 IT 索取完整的根证书"
  fi
  import_ca "$last"
  warn "该证书是从网络中自动获取的：请向 IT 核对上面的 SHA256 指纹，确认它确实是公司代理的根证书"
  rm -rf "$tmp"
}

# Corporate settings often omit the scheme (proxy.corp:8080). curl accepts that, but Node.js refuses to start
# with such a proxy in its environment, so always store and pass on a full URL.
normalize_proxy() {
  proxy_on || return 0
  case "$PROXY_URL" in *://*) ;; *) PROXY_URL="http://$PROXY_URL" ;; esac
  PROXY_URL="${PROXY_URL%/}"
}
app_proxy_ok() { case "$PROXY_URL" in http://*|https://*) return 0 ;; *) return 1 ;; esac; }

apply_network() {
  detect_proxy
  normalize_proxy
  if proxy_on; then
    export http_proxy="$PROXY_URL" https_proxy="$PROXY_URL" HTTP_PROXY="$PROXY_URL" HTTPS_PROXY="$PROXY_URL"
    export npm_config_proxy="$PROXY_URL" npm_config_https_proxy="$PROXY_URL"
  elif [ "$PROXY_URL" = none ]; then
    unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY npm_config_proxy npm_config_https_proxy
  fi
  NO_PROXY_ALL="localhost,127.0.0.1,::1${NO_PROXY_LIST:+,$NO_PROXY_LIST}"
  export no_proxy="$NO_PROXY_ALL" NO_PROXY="$NO_PROXY_ALL" npm_config_noproxy="$NO_PROXY_ALL"
  CURL_TLS=(); APT_NET=(); DNF_NET=()
  if proxy_on; then
    APT_NET+=(-o "Acquire::http::Proxy=$PROXY_URL" -o "Acquire::https::Proxy=$PROXY_URL")
    DNF_NET+=("--setopt=proxy=$PROXY_URL")
  fi
  unset GIT_SSL_NO_VERIFY GIT_SSL_CAINFO npm_config_strict_ssl npm_config_cafile
  if [ "$TLS_INSECURE" = 1 ]; then
    CURL_TLS=(-k)
    export GIT_SSL_NO_VERIFY=true npm_config_strict_ssl=false
    APT_NET+=(-o Acquire::https::Verify-Peer=false -o Acquire::https::Verify-Host=false)
    DNF_NET+=(--setopt=sslverify=False)
  elif [ -n "$CA_CERT" ] && [ -f "$CA_CERT" ]; then
    [ -f "$CERT_DIR/ca-bundle.pem" ] || build_ca_bundle 2>/dev/null || true
    local b="$CERT_DIR/ca-bundle.pem"
    CURL_TLS=(--cacert "$b")
    export GIT_SSL_CAINFO="$b" npm_config_cafile="$b" NODE_EXTRA_CA_CERTS="$CA_CERT"
    APT_NET+=(-o "Acquire::https::CAInfo=$b")
    DNF_NET+=("--setopt=sslcacert=$b")
  fi
}

setup_network() { # handles --ca-cert, then applies everything to this process
  case "$OPT_CA_CERT" in
    ""|none) ;;
    auto) apply_network; fetch_proxy_ca ;;
    *) import_ca "$OPT_CA_CERT" ;;
  esac
  apply_network
}

net_curl() { curl ${CURL_TLS[@]+"${CURL_TLS[@]}"} "$@"; }

explain_curl_error() { # curl exit code, stderr file, url -> one-line cause and fix
  local rc="$1" err="$2" url="$3" issuer last
  last="$(grep -v '^$' "$err" 2>/dev/null | tail -1 | sed 's/^curl: ([0-9]*) //' || true)"
  case "$rc" in
    5) echo "无法解析代理服务器地址 $(mask_url "$PROXY_URL")" ;;
    6) if proxy_on; then echo "无法解析域名 $(url_host "$url")：$last"
       else echo "无法解析域名 $(url_host "$url")（本机 DNS 无法解析外网域名；公司网络通常需经代理上网，请用 --proxy http://代理:端口 指定）"; fi ;;
    7) if proxy_on; then echo "无法连接（请确认代理 $(mask_url "$PROXY_URL") 可用）：$last"
       else echo "无法建立连接（可能需要通过代理上网：--proxy http://代理:端口，或被防火墙拦截）"; fi ;;
    28) echo "连接超时（可能需要通过代理上网，或代理/下载源响应过慢）" ;;
    22) echo "服务器返回错误：$last" ;;
    56|52) if grep -q 407 "$err" 2>/dev/null; then echo "代理要求身份认证（HTTP 407）：请使用 --proxy http://用户名:密码@代理:端口"
           else echo "连接被代理或服务器中断：$last"; fi ;;
    35|51|58|60|77|83|90|91)
      issuer="$(curl -skv --connect-timeout 10 --max-time 20 -o /dev/null "$url" 2>&1 | sed -nE 's/^\*[[:space:]]+issuer: //p' | head -1 || true)"
      echo "HTTPS 证书校验失败（证书签发者：${issuer:-未知}）。公司代理通常会解密 HTTPS 并用自己的证书重新签名：请用 --ca-cert 公司根证书.pem 信任它（或 --ca-cert auto 自动从代理获取），无法获得证书时可用 --insecure 跳过校验" ;;
    *) echo "curl 错误 $rc：$last" ;;
  esac
}

# Proxies often let the registry API through but block or rewrite package archives (binaries, size limits),
# so download the largest dependency and compare it with the lockfile's checksum.
probe_npm_tarball() {
  local registry="${NPM_REGISTRY:-https://registry.npmjs.org}" lock="" f url integrity tmp err rc=0 got why size what
  for f in "$SCRIPT_DIR/server/package-lock.json" "$BASE_DIR/current/server/package-lock.json"; do
    [ -f "$f" ] && { lock="$f"; break; }
  done
  [ -n "$lock" ] || return 0
  read -r url integrity < <(awk '/"node_modules\/better-sqlite3": \{/ {f=1}
    f && /"resolved":/ {gsub(/[",]/, "", $2); u=$2}
    f && /"integrity":/ {gsub(/[",]/, "", $2); print u, $2; exit}' "$lock") || true
  [ -n "${url:-}" ] || return 0
  url="${registry%/}/${url#https://registry.npmjs.org/}"
  local label; label="npm 包下载（$(basename "$url")，含预编译二进制）"
  tmp="$(mktemp)"; err="$(mktemp)"
  net_curl -sS -f -o "$tmp" --connect-timeout 10 --max-time 180 "$url" 2>"$err" || rc=$?
  if [ "$rc" != 0 ]; then
    why="$(explain_curl_error "$rc" "$err" "$url")"
    grep -q 'error: 403' "$err" && why="被拒绝（HTTP 403）：公司代理可能按文件类型或大小拦截了 npm 包。请让 IT 放行 $registry 的 .tgz 下载，或用 --npm-registry 指定公司内部 npm 镜像"
    NET_FAIL=$((NET_FAIL + 1)); printf '%s[%s] ✘   %s：%s%s\n' "$c_err" "$(date '+%F %T')" "$label" "$why" "$c_off" >&2
  elif have openssl && [ "${integrity%%-*}" = sha512 ]; then
    got="sha512-$(openssl dgst -sha512 -binary "$tmp" | base64 | tr -d '\n')"
    size="$(wc -c < "$tmp" | tr -d ' ')"
    if [ "$got" = "$integrity" ]; then ok "  $label：下载完整（$((size / 1024)) KB，校验一致）"
    else
      NET_FAIL=$((NET_FAIL + 1))
      what="收到 $size 字节"
      [ "$(head -c 2 "$tmp" | od -An -tx1 | tr -d ' \n')" = 1f8b ] || what="$what，不是压缩包，像是代理返回的网页：$(head -c 120 "$tmp" | tr -d '\0\r' | tr '\n' ' ')"
      printf '%s[%s] ✘   %s：下载内容与官方校验值不符（%s）。代理可能替换了文件（拦截页、病毒扫描页）或截断了下载，请让 IT 放行 %s 的 .tgz 下载，或用 --npm-registry 指定内部镜像%s\n' \
        "$c_err" "$(date '+%F %T')" "$label" "$what" "$registry" "$c_off" >&2
    fi
  else ok "  $label：可下载"; fi
  rm -f "$tmp" "$err"
}

probe_url() { # label url required(1|0) [file: follow redirects and require 2xx]
  local label="$1" url="$2" req="$3" mode="${4:-}" code rc=0 err why follow=()
  err="$(mktemp)"
  [ "$mode" = file ] && follow=(-L)
  code="$(net_curl -sS ${follow[@]+"${follow[@]}"} -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 30 "$url" 2>"$err")" || rc=$?
  if [ "$rc" = 0 ] && [ "$code" != 407 ] && [ "${code:0:1}" != 5 ] && { [ "$mode" != file ] || [ "${code:0:1}" = 2 ]; }; then
    ok "  $label：可访问（HTTP $code）"
  else
    if [ "$rc" = 0 ]; then
      why="服务器返回 HTTP $code"
      [ "$code" = 407 ] && why="代理要求身份认证（HTTP 407）：请使用 --proxy http://用户名:密码@代理:端口"
    else
      why="$(explain_curl_error "$rc" "$err" "$url")"
    fi
    if [ "$req" = 1 ]; then NET_FAIL=$((NET_FAIL + 1)); printf '%s[%s] ✘   %s：%s%s\n' "$c_err" "$(date '+%F %T')" "$label" "$why" "$c_off" >&2
    else warn "  $label：$why（非必需）"; fi
  fi
  rm -f "$err"
}

probe_git() { # repo branch
  local out rc=0 why
  out="$(GIT_HTTP_LOW_SPEED_LIMIT=1 GIT_HTTP_LOW_SPEED_TIME=30 git_remote ls-remote --heads "$1" "refs/heads/$2" 2>&1)" || rc=$?
  if [ "$rc" = 0 ] && printf '%s' "$out" | grep -qE $'^[0-9a-f]{40}\t'; then ok "  代码仓库（$1）：可访问"; return 0; fi
  case "$out" in
    *"SSL certificate"*|*"certificate verif"*|*"self-signed certificate"*|*"self signed certificate"*)
      why="HTTPS 证书校验失败（公司代理可能在解密 HTTPS）：请用 --ca-cert 公司根证书.pem / --ca-cert auto，或 --insecure" ;;
    *"Could not resolve host"*) why="无法解析域名$(proxy_on || echo '（可能需要 --proxy http://代理:端口）')" ;;
    *407*) why="代理要求身份认证（HTTP 407）：请使用 --proxy http://用户名:密码@代理:端口" ;;
    *"could not read Username"*|*"Authentication failed"*) why="需要身份认证（私有仓库）：请在仓库地址中使用访问令牌，或配置 git 凭据" ;;
    *) why="$(printf '%s' "$out" | grep -v '^$' | tail -1 || true)"; [ -n "$why" ] || why="分支 $2 不存在" ;;
  esac
  NET_FAIL=$((NET_FAIL + 1)); printf '%s[%s] ✘   代码仓库（%s）：%s%s\n' "$c_err" "$(date '+%F %T')" "$1" "$why" "$c_off" >&2
}

apt_probe_url() { # first http(s) repository apt uses
  grep -rhoE '^[[:space:]]*(deb[[:space:]]+(\[[^]]*\][[:space:]]+)?|URIs:[[:space:]]+)https?://[^[:space:]]+' \
    /etc/apt/sources.list /etc/apt/sources.list.d/ 2>/dev/null | grep -oE 'https?://[^[:space:]]+' | head -1 || true
}

# Connection test run before anything is installed; required checks failing aborts the run.
net_preflight() {
  if [ "$OPT_SKIP_NETTEST" = 1 ]; then warn "已跳过网络连接检测（--skip-nettest）"; return 0; fi
  [ "${RS_NETTEST_DONE:-}" = 1 ] && return 0
  set_status running "检测网络连接"
  log "网络连接检测"
  NET_FAIL=0
  if proxy_on; then
    log "  代理：$(mask_url "$PROXY_URL")（来源：$PROXY_SOURCE），直连：$NO_PROXY_ALL"
    app_proxy_ok || warn "  应用调用模型接口只支持 http:// 或 https:// 代理，$(mask_url "$PROXY_URL") 只用于安装下载；应用将直连（可在 $SHARED/extra.env 中设置 HTTPS_PROXY=http://...）"
    local hp; hp="$(proxy_hostport)"
    if timeout 8 bash -c ': </dev/tcp/"$1"/"$2"' _ "${hp%:*}" "${hp##*:}" 2>/dev/null; then ok "  代理服务器 $hp：可连接"
    else NET_FAIL=$((NET_FAIL + 1)); printf '%s[%s] ✘   代理服务器 %s 无法连接，请检查 --proxy 地址与端口%s\n' "$c_err" "$(date '+%F %T')" "$hp" "$c_off" >&2; fi
  else
    log "  代理：未使用（未检测到 https_proxy/http_proxy 环境变量，请确认已用 export 设置；也可用 --proxy http://代理:端口 指定）"
  fi
  if [ "$TLS_INSECURE" = 1 ]; then warn "  HTTPS 证书校验：已关闭（--insecure）"
  elif [ -n "$CA_CERT" ]; then log "  HTTPS 证书校验：系统根证书 + $CA_CERT"
  else log "  HTTPS 证书校验：系统根证书"; fi

  if find_node >/dev/null; then ok "  Node.js：已有可用的 Node.js $NODE_MAJOR+，无需下载"
  elif node_ok "$SCRIPT_DIR/node/bin/node" || [ "$PREBUILT" = 1 ]; then ok "  Node.js：使用发布包自带的版本，无需下载"
  else probe_url "Node.js 下载源（$NODE_MIRROR）" "$NODE_MIRROR/latest-v$NODE_MAJOR.x/SHASUMS256.txt" 1; fi
  if [ "$PREBUILT" = 1 ]; then
    ok "  npm：使用预编译发布包，无需访问 npm 仓库"
  else
    probe_url "npm 仓库（${NPM_REGISTRY:-https://registry.npmjs.org}）" "${NPM_REGISTRY:-https://registry.npmjs.org}/-/ping" 1
    probe_npm_tarball
  fi
  if [ -z "$OPT_FROM" ]; then
    case "$UPDATE_SOURCE" in
      git) case "$REPO_URL" in /*|file://*) ;; *) [ -n "$REPO_URL" ] && probe_git "$REPO_URL" "$BRANCH" ;; esac ;;
      archive) case "$MANIFEST_URL" in http://*|https://*) probe_url "发布清单（$MANIFEST_URL）" "$MANIFEST_URL" 1 file ;; esac ;;
    esac
  fi
  if is_root && [ "$(detect_pkg)" = apt ]; then
    local u; u="$(apt_probe_url)"
    [ -n "$u" ] && probe_url "系统软件源（$u，用于安装字体/LibreOffice 等）" "$u" 0
  fi
  find_system_chrome >/dev/null || probe_url "Chromium 下载（PDF/PPT 导出）" "https://cdn.playwright.dev/" 0
  probe_url "模型接口示例（OpenRouter，应用运行时调用）" "https://openrouter.ai/api/v1/models" 0
  if [ "$NET_FAIL" -gt 0 ]; then
    die "网络连接检测未通过（$NET_FAIL 项必需的连接失败），尚未安装任何组件。请按提示调整参数后重试（可先用 \"bash deploy.sh nettest ...\" 反复检测），或用 --skip-nettest 跳过检测"
  fi
  ok "网络连接检测通过"
}

# ---------------------------------------------------------------- environment
detect_pkg() {
  if have apt-get; then echo apt; elif have dnf; then echo dnf; elif have yum; then echo yum; elif have zypper; then echo zypper; else echo none; fi
}

ensure_system_deps() {
  is_root || { warn "非 root 运行，跳过系统依赖安装（git/curl/tar/字体/浏览器依赖）"; return 0; }
  local pm; pm="$(detect_pkg)"
  log "安装系统依赖（包管理器：$pm）"
  case "$pm" in
    apt)
      export DEBIAN_FRONTEND=noninteractive
      local apt=(apt-get ${APT_NET[@]+"${APT_NET[@]}"})
      "${apt[@]}" update -y -qq || warn "apt-get update 失败"
      "${apt[@]}" install -y -qq git curl ca-certificates tar xz-utils unzip fonts-noto-cjk >/dev/null || warn "部分依赖安装失败"
      # PPT/PDF reference uploads are exported page by page to images.
      "${apt[@]}" install -y -qq --no-install-recommends libreoffice-impress libreoffice-writer poppler-utils >/dev/null \
        || warn "LibreOffice/poppler 安装失败，上传 PPT 参考时将无法逐页转图片"
      ;;
    dnf|yum)
      local dnf=("$pm" ${DNF_NET[@]+"${DNF_NET[@]}"})
      "${dnf[@]}" install -y -q git curl ca-certificates tar xz unzip google-noto-sans-cjk-ttc-fonts >/dev/null 2>&1 \
        || "${dnf[@]}" install -y -q git curl tar xz unzip >/dev/null || warn "部分依赖安装失败"
      "${dnf[@]}" install -y -q libreoffice-impress libreoffice-writer poppler-utils >/dev/null 2>&1 \
        || warn "LibreOffice/poppler 安装失败，上传 PPT 参考时将无法逐页转图片"
      ;;
    zypper)
      zypper -n -q install git curl tar xz unzip noto-sans-sc-fonts >/dev/null || warn "部分依赖安装失败"
      zypper -n -q install libreoffice-impress libreoffice-writer poppler-tools >/dev/null || warn "LibreOffice/poppler 安装失败，上传 PPT 参考时将无法逐页转图片"
      ;;
    *) warn "未识别的包管理器，请手动安装 git curl tar xz unzip、中文字体、LibreOffice 与 poppler-utils" ;;
  esac
}

node_ok() { # usable node: new enough, ships npm, and runnable by the service user
  [ -x "$1" ] && [ "$(as_service_user "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MAJOR" ] \
    && [ -n "$(npm_cli_for "$1")" ]
}

npm_cli_for() { # node binary -> npm-cli.js of the same installation
  local d c; d="$(dirname "$1")"
  for c in "$d/../lib/node_modules/npm/bin/npm-cli.js" "$(readlink -f "$d/npm" 2>/dev/null)"; do
    [ -n "$c" ] && [ -f "$c" ] && { readlink -f "$c"; return 0; }
  done
}

find_node() { # prints a usable node binary: configured, on PATH, or previously downloaded
  if [ -n "$NODE_BIN" ] && node_ok "$NODE_BIN"; then echo "$NODE_BIN"; return 0; fi
  local n
  while read -r n; do
    n="$(readlink -f "$n")"
    if node_ok "$n"; then echo "$n"; return 0; fi
  done < <(type -ap node; true)
  if node_ok "$BASE_DIR/node/bin/node"; then echo "$BASE_DIR/node/bin/node"; return 0; fi
  return 1
}

ensure_node() {
  if [ -n "$NODE_BIN" ] && node_ok "$NODE_BIN"; then return 0; fi
  local found
  if found="$(find_node)"; then
    NODE_BIN="$found"
    [ "$found" = "$BASE_DIR/node/bin/node" ] || ok "使用系统 Node.js $("$NODE_BIN" -v)（$NODE_BIN）"
    return 0
  fi
  local bundled
  for bundled in "$SCRIPT_DIR/node" "${OPT_FROM:-/nonexistent}/node"; do
    if node_ok "$bundled/bin/node"; then
      rm -rf "$BASE_DIR/node.new" && mkdir -p "$BASE_DIR/node.new" && cp -a "$bundled/." "$BASE_DIR/node.new/"
      rm -rf "$BASE_DIR/node" && mv "$BASE_DIR/node.new" "$BASE_DIR/node"
      NODE_BIN="$BASE_DIR/node/bin/node"
      ok "使用发布包自带的 Node.js $("$NODE_BIN" -v)（已复制到 $BASE_DIR/node）"
      return 0
    fi
  done
  local arch
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) die "不支持的 CPU 架构：$(uname -m)" ;; esac
  log "下载 Node.js $NODE_MAJOR（$arch，镜像 $NODE_MIRROR）"
  local tmp; tmp="$(mktemp -d)"
  local url="$NODE_MIRROR/latest-v$NODE_MAJOR.x/SHASUMS256.txt" rc=0
  net_curl -fsSL --connect-timeout 15 "$url" -o "$tmp/SHASUMS256.txt" 2>"$tmp/err" || rc=$?
  [ "$rc" = 0 ] || die "无法获取 Node.js 版本列表（$url）：$(explain_curl_error "$rc" "$tmp/err" "$url")。也可用 --node-mirror 指定内网或国内镜像（如 https://npmmirror.com/mirrors/node）"
  local file
  file="$(grep -oE "node-v$NODE_MAJOR\.[0-9]+\.[0-9]+-linux-$arch\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)"
  [ -n "$file" ] || die "未找到适用的 Node.js 安装包"
  rc=0; net_curl -fsSL --connect-timeout 15 "$NODE_MIRROR/latest-v$NODE_MAJOR.x/$file" -o "$tmp/$file" 2>"$tmp/err" || rc=$?
  [ "$rc" = 0 ] || die "Node.js 下载失败：$(explain_curl_error "$rc" "$tmp/err" "$NODE_MIRROR/latest-v$NODE_MAJOR.x/$file")"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c - >/dev/null) || die "Node.js 安装包校验失败"
  rm -rf "$BASE_DIR/node" && mkdir -p "$BASE_DIR/node"
  tar -xJf "$tmp/$file" -C "$BASE_DIR/node" --strip-components=1
  rm -rf "$tmp"
  NODE_BIN="$BASE_DIR/node/bin/node"
  ok "Node.js $("$NODE_BIN" -v) 已安装到 $BASE_DIR/node"
}

npm_cmd() { # runs npm from the selected node
  local npm_cli; npm_cli="$(npm_cli_for "$NODE_BIN")"
  [ -n "$npm_cli" ] || die "未找到与 $NODE_BIN 配套的 npm"
  local reg=(); [ -n "$NPM_REGISTRY" ] && reg=(--registry "$NPM_REGISTRY")
  local runner=("$NODE_BIN" "$npm_cli")
  # In-app updates inherit NODE_ENV=production from the app, which would make npm skip build tools.
  env -u NODE_ENV PATH="$(dirname "$NODE_BIN"):$PATH" npm_config_cache="$SHARED/npm-cache" \
    "${runner[@]}" "$@" "${reg[@]}" --no-audit --no-fund --no-update-notifier --loglevel=error
}

NPM_WHY=""; NPM_TRANSIENT=0
explain_npm_error() { # npm output file, lockfile -> NPM_WHY (cause and fix), NPM_TRANSIENT=1 when worth retrying
  local f="$1" lock="${2:-}" registry="${NPM_REGISTRY:-https://registry.npmjs.org}" pkg last hash
  NPM_TRANSIENT=0
  pkg="$(grep -oE 'https?://[^ ]+\.tgz' "$f" | tail -1 | sed -E 's#.*/-/##; s#\.tgz$##' || true)"
  hash="$(grep -oE 'wanted sha512-[A-Za-z0-9+/=]+' "$f" | head -1 | sed 's/^wanted //' || true)"
  if [ -z "$pkg" ] && [ -n "$hash" ] && [ -f "$lock" ]; then
    pkg="$(awk -v h="$hash" '/^    "node_modules\// {k=$1; gsub(/[":]/, "", k); sub(/.*node_modules\//, "", k)}
      index($0, h) {print k; exit}' "$lock")"
  fi
  pkg="${pkg:-某个依赖包}"
  if grep -qE 'SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT|unable to get local issuer|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|ERR_TLS_CERT|self[- ]signed certificate' "$f"; then
    NPM_WHY="下载 npm 包时 HTTPS 证书校验失败：请用 --ca-cert 公司根证书.pem（或 --ca-cert auto），无法获得证书时可用 --insecure"
  elif grep -qE 'E407|407 Proxy' "$f"; then
    NPM_WHY="代理要求身份认证（HTTP 407）：请使用 --proxy http://用户名:密码@代理:端口"
  elif grep -qE 'EINTEGRITY|integrity checksum failed' "$f"; then
    NPM_WHY="下载的 $pkg 与官方校验值不符：代理可能替换或截断了文件（拦截页、病毒扫描页、大小限制）。请让 IT 放行 $registry 的 .tgz 下载，或用 --npm-registry 指定公司内部 npm 镜像"
  elif grep -qE 'E403|403 Forbidden' "$f"; then
    NPM_WHY="$pkg 的下载被拒绝（HTTP 403）：通常是公司代理按文件类型或大小拦截（该包含预编译的二进制文件）。请让 IT 放行 $registry 的 .tgz 下载，或用 --npm-registry 指定公司内部 npm 镜像"
  elif grep -qE 'E404|404 Not Found' "$f"; then
    NPM_WHY="npm 仓库中找不到 $pkg（HTTP 404）：若使用了 --npm-registry 镜像，请确认它同步了该包"
  elif grep -qE 'ENOSPC|no space left' "$f"; then
    NPM_WHY="磁盘空间不足（df -h $BASE_DIR）"
  elif grep -qE 'EACCES|EPERM' "$f"; then
    NPM_WHY="文件权限不足：$(grep -m1 -E 'EACCES|EPERM|path ' "$f" | sed 's/^npm error //')"
  elif grep -qE 'ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|socket hang up|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EPIPE|network' "$f"; then
    NPM_TRANSIENT=1
    NPM_WHY="下载 $pkg 时网络中断或超时：请检查代理 / 网络，或用 --npm-registry 换一个更近的镜像"
  else
    last="$(grep -E '^npm (error|ERR!)' "$f" | grep -v 'complete log' | tail -1 | sed -E 's/^npm (error|ERR!) //' || true)"
    NPM_WHY="${last:-npm 退出但未给出原因}"
  fi
}

npm_install() { # dir label
  local dir="$1" label="$2" sub=install out n
  [ -f "$dir/package-lock.json" ] && sub=ci
  out="$(mktemp)"
  for n in 1 2; do
    if (cd "$dir" && npm_cmd "$sub" --include=dev) 2>&1 | tee "$out"; then rm -f "$out"; return 0; fi
    explain_npm_error "$out" "$dir/package-lock.json"
    if [ "$NPM_TRANSIENT" = 1 ] && [ "$n" = 1 ]; then warn "$label依赖安装失败（$NPM_WHY），10 秒后重试"; sleep 10; continue; fi
    break
  done
  rm -f "$out"
  die "$label依赖安装失败：$NPM_WHY"
}

find_system_chrome() {
  local c
  for c in "${CHROME_PATH:-}" /usr/bin/google-chrome /usr/local/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

ensure_browser() { # release dir
  if find_system_chrome >/dev/null; then ok "使用系统浏览器 $(find_system_chrome)（用于 PDF/PPT 导出）"; return 0; fi
  local cli="$1/server/node_modules/playwright-core/cli.js"
  export PLAYWRIGHT_BROWSERS_PATH="$SHARED/ms-playwright"
  if compgen -G "$PLAYWRIGHT_BROWSERS_PATH/chromium*" >/dev/null; then return 0; fi
  log "下载 Chromium（用于 PDF/PPT 导出）"
  if is_root && [ "$(detect_pkg)" = apt ]; then "$NODE_BIN" "$cli" install-deps chromium >/dev/null 2>&1 || warn "Chromium 系统依赖安装失败"; fi
  ( [ "$TLS_INSECURE" = 1 ] && export NODE_TLS_REJECT_UNAUTHORIZED=0; "$NODE_BIN" "$cli" install chromium >/dev/null ) || warn "Chromium 下载失败，PDF/PPT 导出将不可用（可设置 CHROME_PATH 指向已有浏览器）"
}

# ---------------------------------------------------------------- versions & sources
current_release() { [ -L "$CURRENT" ] && readlink -f "$CURRENT" || true; }

version_field() { # file field
  [ -f "$1" ] || return 0
  "$NODE_BIN" -e 'try{const v=require(process.argv[1]);process.stdout.write(String(v[process.argv[2]]??""))}catch{}' "$1" "$2"
}

current_version() { version_field "$CURRENT/VERSION.json" version; }
current_commit() { version_field "$CURRENT/VERSION.json" commit; }

fetch_manifest() { # -> prints manifest json
  [ -n "$MANIFEST_URL" ] || die "未配置发布清单地址（MANIFEST_URL）"
  case "$MANIFEST_URL" in
    http://*|https://*)
      local err rc=0; err="$(mktemp)"
      net_curl -fsSL --connect-timeout 15 --max-time 60 "$MANIFEST_URL" 2>"$err" || rc=$?
      [ "$rc" = 0 ] || { warn "获取发布清单失败：$(explain_curl_error "$rc" "$err" "$MANIFEST_URL")"; rm -f "$err"; return 1; }
      rm -f "$err" ;;
    *) cat "${MANIFEST_URL#file://}" ;;
  esac
}

manifest_field() { "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);process.stdout.write(String(m[process.argv[1]]??""))})' "$1"; }

# Prints "latest_id<TAB>latest_label" for the configured source.
latest_remote() {
  case "$UPDATE_SOURCE" in
    git)
      [ -n "$REPO_URL" ] || die "未配置 git 仓库地址（REPO_URL）"
      local sha
      local out
      out="$(git_remote ls-remote "$REPO_URL" "refs/heads/$BRANCH" 2>&1)" || true
      sha="$(printf '%s\n' "$out" | grep -E $'^[0-9a-f]{40}\t' | head -1 | cut -f1)"
      [ -n "$sha" ] || die "无法访问仓库 $REPO_URL 的分支 $BRANCH：$(printf '%s' "$out" | grep -m1 -E 'fatal|error' || echo 分支不存在)"
      printf '%s\t%s\n' "$sha" "$BRANCH@${sha:0:7}"
      ;;
    archive)
      local m v; m="$(fetch_manifest)" || die "无法获取发布清单 $MANIFEST_URL"
      v="$(printf '%s' "$m" | manifest_field version)"
      [ -n "$v" ] || die "发布清单缺少 version 字段"
      printf '%s\t%s\n' "$v" "$v"
      ;;
    local)
      printf '\t\n'
      ;;
    *) die "未知的更新源类型：$UPDATE_SOURCE" ;;
  esac
}

# Local-path repositories are often owned by another user. git drops -c/GIT_CONFIG_* for local transports,
# so trust them through a dedicated global config instead of touching the user's ~/.gitconfig.
git_remote() {
  local gc="$SHARED/gitconfig"
  if [ ! -f "$gc" ]; then
    { mkdir -p "$SHARED" && printf '[safe]\n\tdirectory = *\n' > "$gc"; } 2>/dev/null || { gc="$(mktemp)"; printf '[safe]\n\tdirectory = *\n' > "$gc"; }
  fi
  GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL="$gc" git "$@"
}

current_id() {
  case "$UPDATE_SOURCE" in git) current_commit ;; *) current_version ;; esac
}

copy_tree() { # src dst
  mkdir -p "$2"
  if [ -f "$1/PREBUILT" ]; then
    tar -C "$1" --exclude=./node --exclude='./server/data' -cf - . | tar -C "$2" -xf -
    return
  fi
  tar -C "$1" --exclude=node_modules --exclude=dist --exclude=.git --exclude='server/data' \
      --exclude='web/test-results' --exclude='web/playwright-report' -cf - . | tar -C "$2" -xf -
}

extract_archive() { # file dst
  local tmp; tmp="$(mktemp -d)"
  case "$1" in
    *.zip) unzip -q "$1" -d "$tmp" ;;
    *.tar.gz|*.tgz) tar -xzf "$1" -C "$tmp" ;;
    *.tar) tar -xf "$1" -C "$tmp" ;;
    *) die "不支持的压缩包格式：$1" ;;
  esac
  local root="$tmp"
  if [ "$(find "$tmp" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ] && [ -d "$(find "$tmp" -mindepth 1 -maxdepth 1)" ]; then
    root="$(find "$tmp" -mindepth 1 -maxdepth 1)"
  fi
  copy_tree "$root" "$2"
  rm -rf "$tmp"
}

# Fetch source into $1; sets SRC_COMMIT, SRC_VERSION, SRC_REF.
fetch_source() {
  local dst="$1"
  SRC_COMMIT=""; SRC_VERSION=""; SRC_REF=""
  if [ -n "$OPT_FROM" ]; then
    [ -e "$OPT_FROM" ] || die "源路径不存在，或用户 $(id -un) 无权访问：$OPT_FROM"
    [ -r "$OPT_FROM" ] || die "用户 $(id -un) 无权读取 $OPT_FROM，请把它放到该用户可读的位置（如 /tmp）"
    log "从本地获取代码：$OPT_FROM"
    if [ -d "$OPT_FROM" ]; then
      copy_tree "$OPT_FROM" "$dst"
      SRC_COMMIT="$(git_remote -C "$OPT_FROM" rev-parse HEAD 2>/dev/null || true)"
    else
      extract_archive "$OPT_FROM" "$dst"
    fi
    SRC_REF="$OPT_FROM"
  else
    case "$UPDATE_SOURCE" in
      git)
        log "从 git 获取代码：$REPO_URL ($BRANCH)"
        local url="$REPO_URL"; case "$url" in /*) url="file://$url" ;; esac  # shallow clones need file:// for local paths
        git_remote clone -q --depth 1 --branch "$BRANCH" "$url" "$dst" || die "git clone 失败"
        SRC_COMMIT="$(git -C "$dst" rev-parse HEAD)"
        rm -rf "$dst/.git"
        SRC_REF="$REPO_URL#$BRANCH"
        ;;
      archive)
        local m url sum tmp
        m="$(fetch_manifest)" || die "无法获取发布清单"
        url="$(printf '%s' "$m" | manifest_field url)"; sum="$(printf '%s' "$m" | manifest_field sha256)"
        SRC_VERSION="$(printf '%s' "$m" | manifest_field version)"; SRC_COMMIT="$(printf '%s' "$m" | manifest_field commit)"
        [ -n "$url" ] || die "发布清单缺少 url 字段"
        case "$url" in http://*|https://*|/*) ;; *) url="${MANIFEST_URL%/*}/$url" ;; esac
        log "下载发布包：$url"
        tmp="$(mktemp -d)"
        local fname="$tmp/release.${url##*.}"
        case "$url" in *.tar.gz) fname="$tmp/release.tar.gz" ;; esac
        case "$url" in
          http://*|https://*)
            local rc=0
            net_curl -fSL --connect-timeout 15 --retry 2 "$url" -o "$fname" 2>"$tmp/err" || rc=$?
            [ "$rc" = 0 ] || die "发布包下载失败：$(explain_curl_error "$rc" "$tmp/err" "$url")" ;;
          *) cp "${url#file://}" "$fname" ;;
        esac
        if [ -n "$sum" ]; then
          echo "$sum  $fname" | sha256sum -c - >/dev/null || die "发布包 SHA256 校验失败"
          ok "发布包校验通过"
        fi
        extract_archive "$fname" "$dst"
        rm -rf "$tmp"
        SRC_REF="$MANIFEST_URL"
        ;;
      local)
        [ -n "$LOCAL_SOURCE" ] || die "未指定代码来源，请使用 --from PATH、--repo URL 或 --manifest URL"
        OPT_FROM="$LOCAL_SOURCE"; fetch_source "$dst"; return
        ;;
    esac
  fi
  [ -f "$dst/server/package.json" ] && [ -f "$dst/web/package.json" ] || die "代码结构不正确（缺少 server/ 或 web/）"
  if [ -f "$dst/PREBUILT" ] && [ -f "$dst/VERSION.json" ]; then
    SRC_VERSION="$(version_field "$dst/VERSION.json" version)"
    SRC_COMMIT="$(version_field "$dst/VERSION.json" commit)"
  fi
  if [ -z "$SRC_VERSION" ]; then
    SRC_VERSION="$("$NODE_BIN" -p "require('$dst/package.json').version || '0.0.0'" 2>/dev/null || echo 0.0.0)"
    if [ -n "$SRC_COMMIT" ]; then SRC_VERSION="$SRC_VERSION+${SRC_COMMIT:0:7}"; fi
  fi
}

build_release() { # dir
  local dir="$1"
  if [ -f "$dir/PREBUILT" ]; then
    [ -f "$dir/server/dist/main.js" ] && [ -d "$dir/server/node_modules" ] && [ -f "$dir/web/dist/index.html" ] || die "预编译发布包不完整（缺少 server/dist、server/node_modules 或 web/dist）"
    (cd "$dir/server" && "$NODE_BIN" -e "new (require('better-sqlite3'))(':memory:').close()") \
      || die "预编译发布包中的 SQLite 模块无法在本机加载（$(uname -sm)，$(ldd --version 2>&1 | head -1)）"
    ok "使用预编译版本（无需安装 npm 依赖）"
  else
    [ "$PREBUILT" = 1 ] && die "已设置只使用预编译发布包（PREBUILT=1），但获取到的是源码；请检查 --manifest 地址，或用 --prebuilt 以外的方式安装"
    build_from_source "$dir"
  fi
  cat > "$dir/VERSION.json" <<EOF
{"version":"$(json_escape "$SRC_VERSION")","commit":"$(json_escape "$SRC_COMMIT")","source":"$(json_escape "${OPT_FROM:+local}${OPT_FROM:-$UPDATE_SOURCE}")","ref":"$(json_escape "$SRC_REF")","builtAt":"$(date -u +%FT%TZ)"}
EOF
  ok "构建完成：$SRC_VERSION"
}

build_from_source() { # dir
  local dir="$1"
  log "安装后端依赖并编译"
  npm_install "$dir/server" 后端
  (cd "$dir/server" && "$NODE_BIN" node_modules/typescript/bin/tsc -p .) || die "后端编译失败（TypeScript 报错见上方）"
  (cd "$dir/server" && npm_cmd prune --omit=dev) || die "后端清理开发依赖失败"
  log "安装前端依赖并构建"
  npm_install "$dir/web" 前端
  (cd "$dir/web" && PATH="$(dirname "$NODE_BIN"):$PATH" npm_cmd run build) || die "前端构建失败（报错见上方）"
  rm -rf "$dir/web/node_modules"
  [ -f "$dir/server/dist/main.js" ] && [ -f "$dir/web/dist/index.html" ] || die "构建产物缺失"
}

backup_db() { # release dir -> prints backup path
  local db="$DATA_DIR/roadshow.db"
  [ -f "$db" ] || return 0
  mkdir -p "$BACKUP_DIR"
  local out
  out="$BACKUP_DIR/roadshow-$(date +%Y%m%d-%H%M%S).db"
  ( cd "$1/server" && "$NODE_BIN" -e '
      const D=require("better-sqlite3");const db=new D(process.argv[1],{readonly:true,fileMustExist:true});
      db.backup(process.argv[2]).then(()=>db.close()).catch(e=>{console.error(e.message);process.exit(1)})' "$db" "$out" ) \
    || die "数据库备份失败"
  ls -1t "$BACKUP_DIR"/roadshow-*.db 2>/dev/null | tail -n +8 | xargs -r rm -f
  echo "$out"
}

switch_current() { # release dir
  ln -sfn "$1" "$BASE_DIR/current.new"
  mv -Tf "$BASE_DIR/current.new" "$CURRENT"
  # Replace the installed tool atomically so a running copy (e.g. the supervisor) keeps its own inode.
  cp "$1/deploy.sh" "$BASE_DIR/deploy.sh.new" && chmod +x "$BASE_DIR/deploy.sh.new" && mv -f "$BASE_DIR/deploy.sh.new" "$BASE_DIR/deploy.sh"
}

cleanup_releases() {
  local cur prev keep=$KEEP_RELEASES
  cur="$(current_release)"; prev="$(cat "$RUN_DIR/previous" 2>/dev/null || true)"
  ls -1dt "$RELEASES"/*/ 2>/dev/null | sed 's#/$##' | while read -r r; do
    [ "$r" = "$cur" ] || [ "$r" = "$prev" ] && continue
    keep=$((keep - 1)); [ "$keep" -gt 1 ] && continue
    rm -rf "$r"
  done
}

# ---------------------------------------------------------------- process management
systemd_available() { have systemctl && [ -d /run/systemd/system ]; }

app_pid() { local p; p="$(cat "$RUN_DIR/app.pid" 2>/dev/null || true)"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo "$p"; }
supervisor_pid() { local p; p="$(cat "$RUN_DIR/supervisor.pid" 2>/dev/null || true)"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo "$p"; }

install_systemd_unit() { # writes the unit when missing or changed
  cat > "$UNIT_FILE.new" <<EOF
[Unit]
Description=Roadshow Studio (AI 路演材料生成)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER:-root}
WorkingDirectory=$BASE_DIR
ExecStart=$BASE_DIR/deploy.sh run
Restart=always
RestartSec=3
# Keep an in-app triggered update running while the app itself is restarted.
KillMode=process
TimeoutStopSec=20
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF
  if [ -f "$UNIT_FILE" ] && cmp -s "$UNIT_FILE.new" "$UNIT_FILE"; then rm -f "$UNIT_FILE.new"; return 0; fi
  mv -f "$UNIT_FILE.new" "$UNIT_FILE"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  ok "已安装 systemd 服务：$SERVICE_NAME"
}

# Rollback leaves a marker pointing at the pre-update backup; apply it before the app opens the database.
restore_pending_db() {
  local marker="$RUN_DIR/restore-db" b
  [ -f "$marker" ] || return 0
  b="$(cat "$marker")"
  if [ -n "$b" ] && [ -f "$b" ]; then
    rm -f "$DATA_DIR/roadshow.db-wal" "$DATA_DIR/roadshow.db-shm"
    cp -f "$b" "$DATA_DIR/roadshow.db"
    echo "[$(date '+%F %T')] 已从备份恢复数据库：$b" >&2
  fi
  rm -f "$marker"
}

cmd_run() { # foreground; used by systemd and the supervisor
  exec 9>&-
  [ -f "$APP_ENV" ] || die "未安装（缺少 $APP_ENV）"
  set -a
  # shellcheck source=/dev/null
  . "$APP_ENV"
  set +a
  restore_pending_db
  # Under systemd, keep a copy in app.log as well (the supervisor already writes there).
  if [ -n "${INVOCATION_ID:-}" ]; then mkdir -p "$LOG_DIR"; exec > >(tee -a "$LOG_DIR/app.log") 2>&1; fi
  cd "$CURRENT/server"
  exec "$NODE_BIN" dist/main.js
}

cmd_supervise() {
  exec 9>&-  # never hold the deploy lock
  rm -f "$RUN_DIR/stop"
  echo $$ > "$RUN_DIR/supervisor.pid"
  trap 'touch "$RUN_DIR/stop"; p=$(cat "$RUN_DIR/app.pid" 2>/dev/null); [ -n "$p" ] && kill "$p" 2>/dev/null; exit 0' TERM INT
  while [ ! -f "$RUN_DIR/stop" ]; do
    "$BASE_DIR/deploy.sh" run &
    wait $! || true
    [ -f "$RUN_DIR/stop" ] && break
    echo "[$(date '+%F %T')] 应用已退出，3 秒后重启" >&2
    sleep 3
  done
  rm -f "$RUN_DIR/supervisor.pid"
}

start_app() {
  if [ "$USE_SYSTEMD" = 1 ] && systemd_available; then
    if is_root; then systemctl start "$SERVICE_NAME"; return; fi
    # Running, or waiting to be restarted by systemd (Restart=always): it picks up the new release by itself.
    case "$(systemctl is-active "$SERVICE_NAME" 2>/dev/null)" in active|activating|reloading) return 0 ;; esac
    die "服务 $SERVICE_NAME 未运行，普通用户无法启动它：请执行 sudo systemctl start $SERVICE_NAME（或 sudo $APP_NAME update）"
  else
    if supervisor_pid >/dev/null; then return 0; fi
    mkdir -p "$LOG_DIR"
    if is_root && [ -n "$SERVICE_USER" ] && [ "$SERVICE_USER" != root ]; then
      runuser -u "$SERVICE_USER" -- setsid nohup "$BASE_DIR/deploy.sh" supervise >> "$LOG_DIR/app.log" 2>&1 < /dev/null 9>&- &
    else
      setsid nohup "$BASE_DIR/deploy.sh" supervise >> "$LOG_DIR/app.log" 2>&1 < /dev/null 9>&- &
    fi
    sleep 1
  fi
}

stop_app() {
  if [ "$USE_SYSTEMD" = 1 ] && systemd_available; then
    is_root && systemctl stop "$SERVICE_NAME" || die "请使用 root 执行（systemctl stop $SERVICE_NAME）"
  else
    local s a; s="$(supervisor_pid || true)"; a="$(app_pid || true)"
    touch "$RUN_DIR/stop" 2>/dev/null || true
    [ -n "$s" ] && kill "$s" 2>/dev/null || true
    [ -n "$a" ] && kill "$a" 2>/dev/null || true
    for _ in $(seq 1 20); do { app_pid >/dev/null || supervisor_pid >/dev/null; } || break; sleep 0.5; done
    a="$(app_pid || true)"; [ -n "$a" ] && kill -9 "$a" 2>/dev/null || true
    rm -f "$RUN_DIR/stop"
  fi
}

# Restart without needing root: SIGTERM the app and let systemd (Restart=always) or the supervisor bring it back.
restart_app() {
  if [ "$USE_SYSTEMD" = 1 ] && systemd_available && is_root; then systemctl restart "$SERVICE_NAME"; return; fi
  local a; a="$(app_pid || true)"
  if [ -n "$a" ] && { [ "$USE_SYSTEMD" = 1 ] || supervisor_pid >/dev/null; }; then
    kill "$a"
  elif [ "$USE_SYSTEMD" = 1 ] && systemd_available; then
    start_app
  else
    stop_app; start_app
  fi
}

crash_count() { # restarts observed since restart_marker was called
  [ -n "${CRASH_BASE:-}" ] || { echo 0; return; }
  if [ "$USE_SYSTEMD" = 1 ] && systemd_available; then
    echo $(( $(systemctl show "$SERVICE_NAME" -p NRestarts --value 2>/dev/null || echo 0) - ${CRASH_BASE:-0} ))
  else
    tail -c +"$(( ${CRASH_BASE:-0} + 1 ))" "$LOG_DIR/app.log" 2>/dev/null | grep -c '应用已退出' || true
  fi
}
restart_marker() {
  if [ "$USE_SYSTEMD" = 1 ] && systemd_available; then CRASH_BASE="$(systemctl show "$SERVICE_NAME" -p NRestarts --value 2>/dev/null || echo 0)"
  else CRASH_BASE="$(stat -c %s "$LOG_DIR/app.log" 2>/dev/null || echo 0)"; fi
}

health_check() { # expected version, timeout seconds; fails early if the app keeps crashing
  local want="$1" t="${2:-90}" body
  for _ in $(seq 1 "$t"); do
    body="$(curl --noproxy '*' -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
    if [ -n "$body" ]; then
      if [ -z "$want" ] || printf '%s' "$body" | grep -qF "\"version\":\"$want\""; then return 0; fi
    fi
    if [ "$(crash_count)" -ge 3 ]; then warn "新版本启动后反复崩溃"; return 1; fi
    sleep 1
  done
  return 1
}

# ---------------------------------------------------------------- deploy pipeline
deploy_release() {
  local id rel prev old_prev backup
  STATUS_FROM="$(current_version || true)"
  save_conf
  set_status running "获取代码"
  mkdir -p "$RELEASES" "$DATA_DIR" "$LOG_DIR" "$BACKUP_DIR"
  id="$(date +%Y%m%d-%H%M%S)"
  rel="$RELEASES/$id"
  rm -rf "$rel"
  BUILDING_REL="$rel"
  fetch_source "$rel"
  STATUS_TO="$SRC_VERSION"
  set_status running "构建 $SRC_VERSION"
  build_release "$rel"
  ensure_browser "$rel"
  prev="$(current_release)"
  set_status running "备份数据库"
  backup="$(backup_db "$rel")"
  [ -n "$backup" ] && ok "数据库已备份：$backup"
  set_status running "切换版本并重启"
  write_app_env
  switch_current "$rel"
  BUILDING_REL=""
  old_prev="$(cat "$RUN_DIR/previous" 2>/dev/null || true)"
  [ -n "$prev" ] && echo "$prev" > "$RUN_DIR/previous"
  [ -n "$backup" ] && echo "$backup" > "$RUN_DIR/last-backup"
  fix_owner
  if [ "$USE_SYSTEMD" = 1 ] && systemd_available && is_root; then install_systemd_unit; fi
  restart_marker
  if app_pid >/dev/null || supervisor_pid >/dev/null; then restart_app; else start_app; fi
  set_status running "健康检查"
  if health_check "$SRC_VERSION" 90; then
    ok "部署成功：$SRC_VERSION 正在 http://$HOST:$PORT 运行"
    set_status success "已更新到 $SRC_VERSION"
    cleanup_releases
    return 0
  fi
  warn "健康检查失败，最近日志："
  show_app_log
  if [ -n "$prev" ]; then
    warn "自动回滚到 $(basename "$prev")"
    do_rollback "$prev" "$backup"
    rm -rf "$rel"
    if [ -n "$old_prev" ] && [ -d "$old_prev" ]; then echo "$old_prev" > "$RUN_DIR/previous"; else rm -f "$RUN_DIR/previous"; fi
    set_status rolled_back "更新到 $SRC_VERSION 失败，已自动回滚到 $STATUS_FROM 并恢复数据库"
    STATUS_ACTIVE=0
    die "更新到 $SRC_VERSION 失败，已自动回滚到 $STATUS_FROM"
  fi
  # Nothing to roll back to: don't leave a crash-looping service behind.
  (stop_app) >/dev/null 2>&1 || true
  die "部署失败（服务已停止），完整日志：$(app_log_hint)"
}

app_log_hint() {
  if [ "$USE_SYSTEMD" = 1 ] && systemd_available; then echo "journalctl -u $SERVICE_NAME -n 200 --no-pager（也会写入 $LOG_DIR/app.log）"
  else echo "$LOG_DIR/app.log"; fi
}

show_app_log() {
  if [ "$USE_SYSTEMD" = 1 ] && systemd_available && have journalctl; then
    journalctl -u "$SERVICE_NAME" -n 40 --no-pager -o cat 2>/dev/null | sed 's/^/    /' >&2 || true
  elif [ -f "$LOG_DIR/app.log" ]; then
    tail -n 30 "$LOG_DIR/app.log" | sed 's/^/    /' >&2
  else
    warn "（没有找到应用日志 $LOG_DIR/app.log）"
  fi
}

do_rollback() { # target release, db backup to restore (optional)
  local target="$1" backup="${2:-}"
  set_status running "回滚中"
  switch_current "$target"
  if [ -n "$backup" ] && [ -f "$backup" ]; then
    # Restored by the app at startup before it opens the database.
    echo "$backup" > "$RUN_DIR/restore-db"
  fi
  fix_owner
  restart_marker
  restart_app
  local v; v="$(current_version)"
  if health_check "$v" 90; then
    ok "已回滚到 $v"; set_status rolled_back "已回滚到 $v（已恢复更新前的数据库）" "$v"
  else
    show_app_log; die "回滚后服务仍无法启动，完整日志：$(app_log_hint)"
  fi
}

# ---------------------------------------------------------------- commands
require_installed() {
  [ -f "$CONF" ] && [ -L "$CURRENT" ] && return 0
  [ -f "$CONF" ] && die "$BASE_DIR 中的上次安装没有完成（没有可运行的版本），请重新安装：sudo bash deploy.sh install（会沿用已保存的设置）"
  die "尚未安装，请先执行：sudo bash deploy.sh install"
}

cmd_install() {
  [ "$(uname -s)" = Linux ] || die "仅支持 Linux"
  lock; mkdir -p "$SHARED"; start_logging
  log "安装 $APP_NAME 到 $BASE_DIR（端口 $PORT，更新源 $UPDATE_SOURCE）"
  if [ "$UPDATE_SOURCE" = local ] && [ -z "$OPT_FROM" ] && [ -z "$LOCAL_SOURCE" ]; then
    if [ -f "$SCRIPT_DIR/server/package.json" ]; then OPT_FROM="$SCRIPT_DIR"; else die "请指定 --from PATH、--repo URL 或 --manifest URL"; fi
  fi
  [ "$UPDATE_SOURCE" = local ] && [ -n "$OPT_FROM" ] && LOCAL_SOURCE="$OPT_FROM"
  setup_network
  net_preflight
  if is_root; then
    SERVICE_USER="${OPT_USER:-${SERVICE_USER:-roadshow}}"
    if [ "$SERVICE_USER" != root ] && ! id "$SERVICE_USER" >/dev/null 2>&1; then
      useradd --system --home-dir "$BASE_DIR" --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
        || useradd -r -d "$BASE_DIR" -s /sbin/nologin "$SERVICE_USER"
      ok "已创建系统用户 $SERVICE_USER"
    fi
  else
    SERVICE_USER="$(id -un)"
  fi
  if [ "$OPT_NO_SYSTEMD" = 0 ] && is_root && systemd_available; then USE_SYSTEMD=1; else USE_SYSTEMD=0; fi
  if [ "$USE_SYSTEMD" = 1 ] && [ -f "$UNIT_FILE" ] && ! grep -qxF "WorkingDirectory=$BASE_DIR" "$UNIT_FILE"; then
    # The unit belongs to an installation in another directory: give this one its own service.
    SERVICE_NAME="$APP_NAME-$(basename "$BASE_DIR")"; UNIT_FILE="/etc/systemd/system/$SERVICE_NAME.service"
    warn "systemd 服务 $APP_NAME 属于另一个安装目录，本安装使用服务名 $SERVICE_NAME"
  fi
  [ "$USE_SYSTEMD" = 0 ] && log "使用内置守护进程管理服务（未检测到可用的 systemd 或指定了 --no-systemd）"
  mkdir -p "$RUN_DIR" "$LOG_DIR" "$DATA_DIR" "$BACKUP_DIR" "$RELEASES"
  ensure_system_deps
  ensure_node
  save_conf
  deploy_release
  save_conf
  fix_owner
  if is_root; then
    local link="/usr/local/bin/$APP_NAME" target
    target="$(readlink -f "$link" 2>/dev/null || true)"
    if [ -n "$target" ] && [ "$target" != "$BASE_DIR/deploy.sh" ] && [ -f "$target" ]; then
      warn "命令 $APP_NAME 已指向另一个安装（$target），未覆盖；本实例请使用 $BASE_DIR/deploy.sh"
    else
      ln -sfn "$BASE_DIR/deploy.sh" "$link" && ok "已注册命令：$APP_NAME（等同于 $BASE_DIR/deploy.sh）"
    fi
  fi
  echo
  ok "安装完成！访问 http://<服务器IP>:$PORT ，默认账号 admin / ${ADMIN_PASSWORD:-admin123}"
  echo "   检查更新：$APP_NAME check      更新：$APP_NAME update      状态：$APP_NAME status"
}

cmd_check() {
  require_installed; ensure_node >/dev/null
  local cur latest label avail=false err=""
  cur="$(current_id)"
  if [ "$UPDATE_SOURCE" = local ]; then
    err="更新源为本地目录，请使用 update --from PATH 手动更新，或在 $CONF 中配置 git/archive 更新源"
  else
    local out
    if out="$(latest_remote 2>&1)"; then
      latest="$(printf '%s' "$out" | tail -1 | cut -f1)"; label="$(printf '%s' "$out" | tail -1 | cut -f2)"
      [ -n "$latest" ] && [ "$latest" != "$cur" ] && avail=true
    else
      err="$(printf '%s' "$out" | sed 's/\x1b\[[0-9;]*m//g' | tail -1)"
    fi
  fi
  if [ "$OPT_JSON" = 1 ]; then
    printf '{"source":"%s","ref":"%s","current":"%s","currentVersion":"%s","latest":"%s","latestLabel":"%s","updateAvailable":%s,"error":"%s","checkedAt":%s}\n' \
      "$UPDATE_SOURCE" "$(json_escape "${REPO_URL:-$MANIFEST_URL}${REPO_URL:+#$BRANCH}")" "$(json_escape "$cur")" "$(json_escape "$(current_version)")" \
      "$(json_escape "${latest:-}")" "$(json_escape "${label:-}")" "$avail" "$(json_escape "$err")" "$(date +%s)000"
  else
    echo "当前版本：$(current_version)"
    [ -n "$err" ] && { warn "$err"; return 1; }
    echo "最新版本：$label"
    if [ "$avail" = true ]; then ok "发现新版本，执行 \"$APP_NAME update\" 进行更新"; else ok "已是最新版本"; fi
  fi
}

cmd_update() {
  require_installed; lock; start_logging
  setup_network
  net_preflight
  ensure_node
  STATUS_FROM="$(current_version)"
  if [ -z "$OPT_FROM" ] && [ "$OPT_FORCE" = 0 ]; then
    set_status running "检查更新"
    [ "$UPDATE_SOURCE" = local ] && die "更新源为本地目录，请使用 --from PATH 指定新代码"
    local out latest
    out="$(latest_remote)"; latest="$(printf '%s' "$out" | cut -f1)"
    if [ "$latest" = "$(current_id)" ]; then ok "已是最新版本（$(current_version)）"; set_status success "已是最新版本"; return 0; fi
    log "发现新版本：$(printf '%s' "$out" | cut -f2)"
  fi
  if [ "$OPT_YES" = 0 ] && [ -t 0 ]; then
    read -r -p "确认更新？服务将短暂重启 [y/N] " ans; [[ "$ans" =~ ^[Yy] ]] || { log "已取消"; set_status success "已取消"; return 0; }
  fi
  deploy_release
}

cmd_rollback() {
  require_installed; lock; start_logging; ensure_node
  local prev; prev="$(cat "$RUN_DIR/previous" 2>/dev/null || true)"
  [ -n "$prev" ] && [ -d "$prev" ] || die "没有可回滚的上一个版本"
  STATUS_FROM="$(current_version)"
  local cur; cur="$(current_release)"
  do_rollback "$prev" "$(cat "$RUN_DIR/last-backup" 2>/dev/null || true)"
  echo "$cur" > "$RUN_DIR/previous"
  rm -f "$RUN_DIR/last-backup"
}

cmd_nettest() {
  # Nothing is written: a --ca-cert given here is only used for this test.
  if [ -n "$OPT_CA_CERT" ] && [ "$OPT_CA_CERT" != none ]; then CERT_DIR="$(mktemp -d)"; fi
  setup_network
  OPT_SKIP_NETTEST=0; RS_NETTEST_DONE=""
  net_preflight
  echo "检测通过后，用相同的网络参数执行安装：sudo bash deploy.sh install $(printf '%q ' "${ORIG_ARGS[@]:1}")"
}

cmd_status() {
  require_installed
  echo "安装目录：$BASE_DIR"
  echo "当前版本：$(current_version)  ($(basename "$(current_release)"))"
  echo "监听地址：$HOST:$PORT"
  echo "更新源：  $UPDATE_SOURCE ${REPO_URL:+$REPO_URL#$BRANCH}${MANIFEST_URL}${LOCAL_SOURCE:+$LOCAL_SOURCE}"
  echo "进程管理：$([ "$USE_SYSTEMD" = 1 ] && echo systemd || echo 内置守护进程)"
  local a; a="$(app_pid || true)"
  if [ -n "$a" ] && curl --noproxy '*' -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then ok "运行中（PID $a）"; else warn "未运行"; return 1; fi
}

cmd_uninstall() {
  is_root || [ "$USE_SYSTEMD" = 0 ] || die "请使用 root 执行"
  # An installation from before per-directory service names may share the unit of another directory.
  if [ "$USE_SYSTEMD" = 1 ] && ! grep -qxF "WorkingDirectory=$BASE_DIR" "$UNIT_FILE" 2>/dev/null; then USE_SYSTEMD=0; fi
  stop_app || true
  if [ -f "$UNIT_FILE" ] && grep -qxF "WorkingDirectory=$BASE_DIR" "$UNIT_FILE"; then systemctl disable "$SERVICE_NAME" >/dev/null 2>&1 || true; rm -f "$UNIT_FILE"; systemctl daemon-reload || true; fi
  if [ "$(readlink -f "/usr/local/bin/$APP_NAME" 2>/dev/null)" = "$BASE_DIR/deploy.sh" ]; then rm -f "/usr/local/bin/$APP_NAME"; fi
  if [ "$OPT_PURGE" = 1 ]; then rm -rf "$BASE_DIR"; ok "已删除 $BASE_DIR（含数据）"
  else rm -rf "$RELEASES" "$CURRENT" "$BASE_DIR/node"; ok "已卸载程序，数据保留在 $SHARED（使用 --purge 彻底删除）"; fi
}

# Day-to-day commands run as the service user so files under $BASE_DIR keep a single owner
# (and match what an in-app update, which already runs as that user, produces).
# Root-run updates first refresh system packages, which new versions may depend on.
apply_network
if is_root && [ -n "$SERVICE_USER" ] && [ "$SERVICE_USER" != root ] && [ -L "$CURRENT" ]; then
  case "$CMD" in
    update|auto)
      # The network test and a new --ca-cert are handled here (the CA file may only be readable by root).
      setup_network; net_preflight
      save_conf; [ -d "$CERT_DIR" ] && chown -R "$SERVICE_USER": "$CERT_DIR"
      ensure_system_deps
      # The service user cannot (re)start a stopped unit, e.g. after an earlier failed attempt.
      if [ "$USE_SYSTEMD" = 1 ] && systemd_available; then
        install_systemd_unit
        systemctl reset-failed "$SERVICE_NAME" >/dev/null 2>&1 || true
        systemctl is-active --quiet "$SERVICE_NAME" || systemctl start "$SERVICE_NAME" || true
      fi
      child=(); skip=0
      for a in "${ORIG_ARGS[@]}"; do
        if [ "$skip" = 1 ]; then skip=0; continue; fi
        [ "$a" = --ca-cert ] && { skip=1; continue; }
        child+=("$a")
      done
      exec runuser -u "$SERVICE_USER" -- env HOME="$BASE_DIR" RS_NETTEST_DONE=1 bash "$SCRIPT_PATH" "${child[@]}" ;;
    check|rollback) exec runuser -u "$SERVICE_USER" -- env HOME="$BASE_DIR" bash "$SCRIPT_PATH" "${ORIG_ARGS[@]}" ;;
  esac
fi

case "$CMD" in
  auto) if [ -f "$CONF" ] && [ -L "$CURRENT" ]; then OPT_YES=1; cmd_update; else cmd_install; fi ;;
  install) cmd_install ;;
  check) cmd_check ;;
  update) cmd_update ;;
  rollback) cmd_rollback ;;
  nettest|doctor) cmd_nettest ;;
  start) require_installed; start_app; health_check "" 60 && ok "已启动：http://$HOST:$PORT" || { show_app_log; die "启动失败，完整日志：$(app_log_hint)"; } ;;
  stop) require_installed; stop_app; ok "已停止" ;;
  restart) require_installed; write_app_env; restart_app; health_check "" 60 && ok "已重启" || { show_app_log; die "重启失败，完整日志：$(app_log_hint)"; } ;;
  status) cmd_status ;;
  logs)
    require_installed
    follow=(); [ "$OPT_FOLLOW" = 1 ] && follow=(-f)
    if [ "$USE_SYSTEMD" = 1 ] && systemd_available; then journalctl -u "$SERVICE_NAME" -n 200 "${follow[@]}"
    else tail -n 200 "${follow[@]}" "$LOG_DIR/app.log"; fi ;;
  uninstall) cmd_uninstall ;;
  run) cmd_run ;;
  supervise) cmd_supervise ;;
  help|*) sed -n '2,34p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//' ;;
esac
