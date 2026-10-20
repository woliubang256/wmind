#!/usr/bin/env bash
#
# wmind 恢复：把 backup.sh 的产物写回正在运行的部署。设计见 docs/07-部署与运维.md §7.2。
#
# 用法：
#   ./deploy/scripts/restore.sh <数据库备份文件> [上传文件 tar.gz]
#
# 环境变量：
#   WMIND_DB_DRIVER   sqlite（默认）| postgres
#   FORCE=1           跳过交互确认（用于自动化；请确认你知道自己在做什么）
#
# 恢复是**破坏性**操作：它会替换现有数据库。脚本会先把现有 SQLite 库改名保留
# （wmind.db.before-restore），PostgreSQL 则依赖 pg_restore --clean。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 绝对化：下面会 cd 到 deploy/，之后相对路径就失效了（--help 要读自己的头部）。
SCRIPT_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
cd "$DEPLOY_DIR"

usage() {
  # 读到第一行非注释为止，不写死行号（见 backup.sh 里的同一处说明）。
  awk 'NR < 3 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$SCRIPT_PATH"
}

if [[ $# -lt 1 ]]; then
  usage
  exit 2
fi

DB_DUMP="$1"
UPLOADS_TAR="${2:-}"
DRIVER="${WMIND_DB_DRIVER:-sqlite}"

[[ -f "$DB_DUMP" ]] || {
  echo "数据库备份不存在：$DB_DUMP" >&2
  exit 1
}
if [[ -n "$UPLOADS_TAR" && ! -f "$UPLOADS_TAR" ]]; then
  echo "上传文件备份不存在：$UPLOADS_TAR" >&2
  exit 1
fi

# 驱动名先校验：写错时应当直接说清楚，而不是走完 docker 检测才抱怨。
case "$DRIVER" in
  postgres)
    COMPOSE=(docker compose -f docker-compose.postgres.yml)
    UPLOADS_VOLUME=wmind_uploads
    ;;
  sqlite)
    COMPOSE=(docker compose -f docker-compose.yml)
    UPLOADS_VOLUME=wmind_data
    ;;
  *)
    echo "WMIND_DB_DRIVER 只能是 sqlite 或 postgres，当前：$DRIVER" >&2
    exit 2
    ;;
esac

command -v docker >/dev/null 2>&1 || {
  echo "找不到 docker 命令" >&2
  exit 1
}

DB_DUMP="$(cd "$(dirname "$DB_DUMP")" && pwd)/$(basename "$DB_DUMP")"
if [[ -n "$UPLOADS_TAR" ]]; then
  UPLOADS_TAR="$(cd "$(dirname "$UPLOADS_TAR")" && pwd)/$(basename "$UPLOADS_TAR")"
fi

if [[ "${FORCE:-0}" != "1" ]]; then
  echo "即将用 $DB_DUMP 覆盖当前 $DRIVER 数据库。"
  read -r -p "确认继续？输入 yes： " answer
  [[ "$answer" == "yes" ]] || {
    echo "已取消"
    exit 1
  }
fi

# ── 数据库 ────────────────────────────────────────────────────────────────
if [[ "$DRIVER" == "postgres" ]]; then
  # 先停 api：恢复期间不该有连接在写库（pg_restore --clean 会 DROP 对象）。
  "${COMPOSE[@]}" stop api
  "${COMPOSE[@]}" exec -T db pg_restore \
    -U "${POSTGRES_USER:-wmind}" \
    -d "${POSTGRES_DB:-wmind}" \
    --clean --if-exists --no-owner \
    <"$DB_DUMP"
  "${COMPOSE[@]}" start api
else
  "${COMPOSE[@]}" stop api
  # api 停了就没法 exec，用一次性容器换文件；新文件的属主必须是 10001，
  # 否则 api 启动时报 "attempt to write a readonly database"。
  docker run --rm \
    -v "$UPLOADS_VOLUME:/data" \
    -v "$(dirname "$DB_DUMP")":/backup:ro \
    -e SRC="$(basename "$DB_DUMP")" \
    alpine:3.20 sh -c '
      mv /data/wmind.db /data/wmind.db.before-restore 2>/dev/null || true
      # 旧的 -wal / -shm 必须一起删：它们属于旧库，留着会让 SQLite
      # 拒绝打开新库，或者静默丢弃已提交的数据。
      rm -f /data/wmind.db-wal /data/wmind.db-shm
      cp "/backup/$SRC" /data/wmind.db
      chown 10001:10001 /data/wmind.db
    '
  "${COMPOSE[@]}" start api
fi

# ── 上传文件 ──────────────────────────────────────────────────────────────
if [[ -n "$UPLOADS_TAR" ]]; then
  # 目标目录写死 /data/uploads 而不是卷根：SQLite 部署里数据库和上传文件共用
  # data 卷，对卷根 rm -rf 会把刚恢复好的数据库一起删掉。
  docker run --rm \
    -v "$UPLOADS_VOLUME:/data" \
    -v "$(dirname "$UPLOADS_TAR")":/backup:ro \
    -e SRC="$(basename "$UPLOADS_TAR")" \
    alpine:3.20 sh -c '
      mkdir -p /data/uploads
      rm -rf /data/uploads/*
      tar xzf "/backup/$SRC" -C /data/uploads
      chown -R 10001:10001 /data/uploads
    '
fi

echo "恢复完成。检查服务状态："
"${COMPOSE[@]}" ps
# 端口取 compose 里的设置；这里展开成实际值，否则打印出来的是带 ${} 的字面量。
HTTP_PORT="${HTTP_PORT:-80}"
echo "健康检查：curl -fsS http://127.0.0.1:$HTTP_PORT/api/v1/health/ready"
