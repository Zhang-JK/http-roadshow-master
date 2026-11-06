#!/usr/bin/env bash
# Roadshow Studio — one-click deploy / update tool for Linux.
#
#   sudo bash deploy.sh                      # 一键：未安装则安装，已安装则检查并更新
#   sudo bash deploy.sh install [options]    # 安装并启动（默认端口 9090）
#   bash deploy.sh check [--json]            # 检查是否有新版本
#   bash deploy.sh update [--yes] [--force] [--from PATH]
#   bash deploy.sh rollback                  # 回滚到上一个版本（同时恢复更新前的数据库备份）
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
while [ $# -gt 0 ]; do
  case "$1" in
    --source) OPT_SOURCE="$2"; shift ;;
    --repo) OPT_REPO="$2"; shift ;;
    --branch) OPT_BRANCH="$2"; shift ;;
    --manifest) OPT_MANIFEST="$2"; shift ;;
    --from) OPT_FROM="$(readlink -f "$2")"; shift ;;
    --port) OPT_PORT="$2"; shift ;;
    --host) OPT_HOST="$2"; shift ;;
    --base) OPT_BASE="$2"; shift ;;
    --user) OPT_USER="$2"; shift ;;
    --no-systemd) OPT_NO_SYSTEMD=1 ;;
    --admin-password) OPT_ADMIN_PWD="$2"; shift ;;
    --npm-registry) OPT_NPM_REGISTRY="$2"; shift ;;
    --node-mirror) OPT_NODE_MIRROR="$2"; shift ;;
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
UNIT_FILE="/etc/systemd/system/$APP_NAME.service"

# Defaults, overridden by deploy.conf, then by command-line options.
PORT=9090; HOST=0.0.0.0; UPDATE_SOURCE=local; REPO_URL=""; BRANCH=main; MANIFEST_URL=""; LOCAL_SOURCE=""
SERVICE_USER=""; USE_SYSTEMD=0; NODE_BIN=""; KEEP_RELEASES=3; NPM_REGISTRY=""; NODE_MIRROR="https://nodejs.org/dist"
ADMIN_PASSWORD=""
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
if [ -n "$OPT_SOURCE" ]; then UPDATE_SOURCE="$OPT_SOURCE"
elif [ -n "$OPT_REPO" ]; then UPDATE_SOURCE=git
elif [ -n "$OPT_MANIFEST" ]; then UPDATE_SOURCE=archive; fi

# Day-to-day commands run as the service user so files under $BASE_DIR keep a single owner
# (and match what an in-app update, which already runs as that user, produces).
if [ "$(id -u)" -eq 0 ] && [ -n "$SERVICE_USER" ] && [ "$SERVICE_USER" != root ] && [ -L "$CURRENT" ]; then
  case "$CMD" in
    check|update|rollback|auto) exec runuser -u "$SERVICE_USER" -- env HOME="$BASE_DIR" bash "$SCRIPT_PATH" "${ORIG_ARGS[@]}" ;;
  esac
fi

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
EOF
  mv -f "$CONF.tmp" "$CONF"
  chmod 600 "$CONF"
}

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
  [ -f "$SHARED/extra.env" ] && cat "$SHARED/extra.env" >> "$APP_ENV.tmp"
  mv -f "$APP_ENV.tmp" "$APP_ENV"
  chmod 600 "$APP_ENV"
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
      apt-get update -y -qq || warn "apt-get update 失败"
      apt-get install -y -qq git curl ca-certificates tar xz-utils unzip fonts-noto-cjk >/dev/null || warn "部分依赖安装失败"
      ;;
    dnf|yum)
      "$pm" install -y -q git curl ca-certificates tar xz unzip google-noto-sans-cjk-ttc-fonts >/dev/null 2>&1 \
        || "$pm" install -y -q git curl tar xz unzip >/dev/null || warn "部分依赖安装失败"
      ;;
    zypper) zypper -n -q install git curl tar xz unzip noto-sans-sc-fonts >/dev/null || warn "部分依赖安装失败" ;;
    *) warn "未识别的包管理器，请手动安装 git curl tar xz unzip 与中文字体" ;;
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

ensure_node() {
  if [ -n "$NODE_BIN" ] && node_ok "$NODE_BIN"; then return 0; fi
  local n
  while read -r n; do
    n="$(readlink -f "$n")"
    if node_ok "$n"; then NODE_BIN="$n"; ok "使用系统 Node.js $("$NODE_BIN" -v)（$NODE_BIN）"; return 0; fi
  done < <(type -ap node; true)
  if node_ok "$BASE_DIR/node/bin/node"; then NODE_BIN="$BASE_DIR/node/bin/node"; return 0; fi
  local arch
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) die "不支持的 CPU 架构：$(uname -m)" ;; esac
  log "下载 Node.js $NODE_MAJOR（$arch，镜像 $NODE_MIRROR）"
  local tmp; tmp="$(mktemp -d)"
  curl -fsSL "$NODE_MIRROR/latest-v$NODE_MAJOR.x/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt" || die "无法获取 Node.js 版本列表"
  local file
  file="$(grep -oE "node-v$NODE_MAJOR\.[0-9]+\.[0-9]+-linux-$arch\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)"
  [ -n "$file" ] || die "未找到适用的 Node.js 安装包"
  curl -fsSL "$NODE_MIRROR/latest-v$NODE_MAJOR.x/$file" -o "$tmp/$file" || die "Node.js 下载失败"
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
  "$NODE_BIN" "$cli" install chromium >/dev/null || warn "Chromium 下载失败，PDF/PPT 导出将不可用（可设置 CHROME_PATH 指向已有浏览器）"
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
    http://*|https://*) curl -fsSL --max-time 30 "$MANIFEST_URL" ;;
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
  [ -f "$gc" ] || printf '[safe]\n\tdirectory = *\n' > "$gc"
  GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL="$gc" git "$@"
}

current_id() {
  case "$UPDATE_SOURCE" in git) current_commit ;; *) current_version ;; esac
}

copy_tree() { # src dst
  mkdir -p "$2"
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
    [ -e "$OPT_FROM" ] || die "源路径不存在：$OPT_FROM"
    log "从本地获取代码：$OPT_FROM"
    if [ -d "$OPT_FROM" ]; then
      copy_tree "$OPT_FROM" "$dst"
      SRC_COMMIT="$(git -C "$OPT_FROM" rev-parse HEAD 2>/dev/null || true)"
    else
      extract_archive "$OPT_FROM" "$dst"
    fi
    SRC_REF="$OPT_FROM"
  else
    case "$UPDATE_SOURCE" in
      git)
        log "从 git 获取代码：$REPO_URL ($BRANCH)"
        git_remote clone -q --depth 1 --branch "$BRANCH" "$REPO_URL" "$dst" || die "git clone 失败"
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
        case "$url" in http://*|https://*) curl -fsSL "$url" -o "$fname" || die "发布包下载失败" ;; *) cp "${url#file://}" "$fname" ;; esac
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
  if [ -z "$SRC_VERSION" ]; then
    SRC_VERSION="$("$NODE_BIN" -p "require('$dst/package.json').version || '0.0.0'" 2>/dev/null || echo 0.0.0)"
    [ -n "$SRC_COMMIT" ] && SRC_VERSION="$SRC_VERSION+${SRC_COMMIT:0:7}"
  fi
}

build_release() { # dir
  local dir="$1"
  log "安装后端依赖并编译"
  ( cd "$dir/server"
    if [ -f package-lock.json ]; then npm_cmd ci --include=dev; else npm_cmd install --include=dev; fi
    "$NODE_BIN" node_modules/typescript/bin/tsc -p . || "$NODE_BIN" node_modules/.bin/tsc -p .
    npm_cmd prune --omit=dev ) || die "后端构建失败"
  log "安装前端依赖并构建"
  ( cd "$dir/web"
    if [ -f package-lock.json ]; then npm_cmd ci --include=dev; else npm_cmd install --include=dev; fi
    PATH="$(dirname "$NODE_BIN"):$PATH" npm_cmd run build
    rm -rf node_modules ) || die "前端构建失败"
  [ -f "$dir/server/dist/main.js" ] && [ -f "$dir/web/dist/index.html" ] || die "构建产物缺失"
  cat > "$dir/VERSION.json" <<EOF
{"version":"$(json_escape "$SRC_VERSION")","commit":"$(json_escape "$SRC_COMMIT")","source":"$(json_escape "${OPT_FROM:+local}${OPT_FROM:-$UPDATE_SOURCE}")","ref":"$(json_escape "$SRC_REF")","builtAt":"$(date -u +%FT%TZ)"}
EOF
  ok "构建完成：$SRC_VERSION"
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

install_systemd_unit() {
  cat > "$UNIT_FILE" <<EOF
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
  systemctl daemon-reload
  systemctl enable "$APP_NAME" >/dev/null 2>&1 || true
  ok "已安装 systemd 服务：$APP_NAME"
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
    is_root && systemctl start "$APP_NAME" || die "请使用 root 执行（systemctl start $APP_NAME）"
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
    is_root && systemctl stop "$APP_NAME" || die "请使用 root 执行（systemctl stop $APP_NAME）"
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
  if [ "$USE_SYSTEMD" = 1 ] && systemd_available && is_root; then systemctl restart "$APP_NAME"; return; fi
  local a; a="$(app_pid || true)"
  if [ -n "$a" ] && { [ "$USE_SYSTEMD" = 1 ] || supervisor_pid >/dev/null; }; then
    kill "$a"
  else
    stop_app; start_app
  fi
}

crash_count() { # restarts observed since restart_marker was called
  [ -n "${CRASH_BASE:-}" ] || { echo 0; return; }
  if [ "$USE_SYSTEMD" = 1 ] && systemd_available; then
    echo $(( $(systemctl show "$APP_NAME" -p NRestarts --value 2>/dev/null || echo 0) - ${CRASH_BASE:-0} ))
  else
    tail -c +"$(( ${CRASH_BASE:-0} + 1 ))" "$LOG_DIR/app.log" 2>/dev/null | grep -c '应用已退出' || true
  fi
}
restart_marker() {
  if [ "$USE_SYSTEMD" = 1 ] && systemd_available; then CRASH_BASE="$(systemctl show "$APP_NAME" -p NRestarts --value 2>/dev/null || echo 0)"
  else CRASH_BASE="$(stat -c %s "$LOG_DIR/app.log" 2>/dev/null || echo 0)"; fi
}

health_check() { # expected version, timeout seconds; fails early if the app keeps crashing
  local want="$1" t="${2:-90}" body
  for _ in $(seq 1 "$t"); do
    body="$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || true)"
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
  if [ "$USE_SYSTEMD" = 1 ] && systemd_available && is_root && [ ! -f "$UNIT_FILE" ]; then install_systemd_unit; fi
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
  tail -n 30 "$LOG_DIR/app.log" 2>/dev/null >&2 || true
  if [ -n "$prev" ]; then
    warn "自动回滚到 $(basename "$prev")"
    do_rollback "$prev" "$backup"
    rm -rf "$rel"
    if [ -n "$old_prev" ] && [ -d "$old_prev" ]; then echo "$old_prev" > "$RUN_DIR/previous"; else rm -f "$RUN_DIR/previous"; fi
    set_status rolled_back "更新到 $SRC_VERSION 失败，已自动回滚到 $STATUS_FROM 并恢复数据库"
    STATUS_ACTIVE=0
    die "更新到 $SRC_VERSION 失败，已自动回滚到 $STATUS_FROM"
  fi
  die "部署失败，请查看日志：$LOG_DIR/app.log"
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
    die "回滚后服务仍无法启动，请查看 $LOG_DIR/app.log"
  fi
}

# ---------------------------------------------------------------- commands
require_installed() { [ -f "$CONF" ] && [ -L "$CURRENT" ] || die "尚未安装，请先执行：sudo bash deploy.sh install"; }

cmd_install() {
  [ "$(uname -s)" = Linux ] || die "仅支持 Linux"
  lock; mkdir -p "$SHARED"; start_logging
  log "安装 $APP_NAME 到 $BASE_DIR（端口 $PORT，更新源 $UPDATE_SOURCE）"
  if [ "$UPDATE_SOURCE" = local ] && [ -z "$OPT_FROM" ] && [ -z "$LOCAL_SOURCE" ]; then
    if [ -f "$SCRIPT_DIR/server/package.json" ]; then OPT_FROM="$SCRIPT_DIR"; else die "请指定 --from PATH、--repo URL 或 --manifest URL"; fi
  fi
  [ "$UPDATE_SOURCE" = local ] && [ -n "$OPT_FROM" ] && LOCAL_SOURCE="$OPT_FROM"
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
  [ "$USE_SYSTEMD" = 0 ] && log "使用内置守护进程管理服务（未检测到可用的 systemd 或指定了 --no-systemd）"
  mkdir -p "$RUN_DIR" "$LOG_DIR" "$DATA_DIR" "$BACKUP_DIR" "$RELEASES"
  ensure_system_deps
  ensure_node
  save_conf
  deploy_release
  save_conf
  fix_owner
  if is_root; then ln -sfn "$BASE_DIR/deploy.sh" "/usr/local/bin/$APP_NAME" && ok "已注册命令：$APP_NAME（等同于 $BASE_DIR/deploy.sh）"; fi
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
  require_installed; lock; start_logging; ensure_node
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

cmd_status() {
  require_installed
  echo "安装目录：$BASE_DIR"
  echo "当前版本：$(current_version)  ($(basename "$(current_release)"))"
  echo "监听地址：$HOST:$PORT"
  echo "更新源：  $UPDATE_SOURCE ${REPO_URL:+$REPO_URL#$BRANCH}${MANIFEST_URL}${LOCAL_SOURCE:+$LOCAL_SOURCE}"
  echo "进程管理：$([ "$USE_SYSTEMD" = 1 ] && echo systemd || echo 内置守护进程)"
  local a; a="$(app_pid || true)"
  if [ -n "$a" ] && curl -fsS --max-time 3 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then ok "运行中（PID $a）"; else warn "未运行"; return 1; fi
}

cmd_uninstall() {
  is_root || [ "$USE_SYSTEMD" = 0 ] || die "请使用 root 执行"
  stop_app || true
  if [ -f "$UNIT_FILE" ]; then systemctl disable "$APP_NAME" >/dev/null 2>&1 || true; rm -f "$UNIT_FILE"; systemctl daemon-reload || true; fi
  rm -f "/usr/local/bin/$APP_NAME"
  if [ "$OPT_PURGE" = 1 ]; then rm -rf "$BASE_DIR"; ok "已删除 $BASE_DIR（含数据）"
  else rm -rf "$RELEASES" "$CURRENT" "$BASE_DIR/node"; ok "已卸载程序，数据保留在 $SHARED（使用 --purge 彻底删除）"; fi
}

case "$CMD" in
  auto) if [ -f "$CONF" ] && [ -L "$CURRENT" ]; then OPT_YES=1; cmd_update; else cmd_install; fi ;;
  install) cmd_install ;;
  check) cmd_check ;;
  update) cmd_update ;;
  rollback) cmd_rollback ;;
  start) require_installed; start_app; health_check "" 60 && ok "已启动：http://$HOST:$PORT" || die "启动失败，请查看 $LOG_DIR/app.log" ;;
  stop) require_installed; stop_app; ok "已停止" ;;
  restart) require_installed; write_app_env; restart_app; health_check "" 60 && ok "已重启" || die "重启失败，请查看 $LOG_DIR/app.log" ;;
  status) cmd_status ;;
  logs)
    require_installed
    follow=(); [ "$OPT_FOLLOW" = 1 ] && follow=(-f)
    if [ "$USE_SYSTEMD" = 1 ] && systemd_available; then journalctl -u "$APP_NAME" -n 200 "${follow[@]}"
    else tail -n 200 "${follow[@]}" "$LOG_DIR/app.log"; fi ;;
  uninstall) cmd_uninstall ;;
  run) cmd_run ;;
  supervise) cmd_supervise ;;
  help|*) sed -n '2,25p' "$SCRIPT_PATH" | sed 's/^# \{0,1\}//' ;;
esac
