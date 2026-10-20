#!/usr/bin/env bash
#
# wmind 备份：数据库 + 上传文件。设计与取舍见 docs/07-部署与运维.md §7。
#
# 用法：
#   ./deploy/scripts/backup.sh [--with-env]
#
# 环境变量：
#   WMIND_DB_DRIVER   sqlite（默认）| postgres，与 compose 里的设置保持一致
#   BACKUP_DIR        备份输出目录，默认 ./backups
#   KEEP_DAYS         保留天数，默认 30（只清理本脚本产出的 wmind-* 文件）
#
# 两种方言的备份机制完全不同，所以不能共用一条命令：
#   SQLite     VACUUM INTO（服务二进制自带的 db backup 子命令），不停机
#   PostgreSQL pg_dump --format=custom，不停机
#
# 绝对不要 `cp /data/wmind.db`：WAL 模式下 .db 文件可能不含最近的提交，
# 拷出来会丢数据；运行中直接拷还可能撞上正在写的页。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 绝对化：下面会 cd 到 deploy/，之后 ${BASH_SOURCE[0]} 的相对路径就失效了
# （--help 要回头读自己的头部注释）。
SCRIPT_PATH="$SCRIPT_DIR/$(basename "${BASH_SOURCE[0]}")"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"

# 切到 deploy/ 再跑 compose：.env 与 yml 都在那里，从任意目录调用都能工作。
cd "$DEPLOY_DIR"

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DRIVER="${WMIND_DB_DRIVER:-sqlite}"
WITH_ENV=0

for arg in "$@"; do
  case "$arg" in
    --with-env) WITH_ENV=1 ;;
    -h | --help)
      # 从第 3 行开始，遇到第一行非注释就停：写死行号的话，改注释就会漏出
      # 后面的 `set -euo pipefail`。
      awk 'NR < 3 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$SCRIPT_PATH"
      exit 0
      ;;
    *)
      echo "未知参数：${arg}（可用：--with-env）" >&2
      exit 2
      ;;
  esac
done

# 参数与配置先校验，再查环境：驱动名写错时应当直接说清楚，而不是先抱怨没装 docker。
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

mkdir -p "$BACKUP_DIR"
# 后面 docker run 要挂绝对路径：相对路径在 -v 里会被当成卷名。
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd)"

# ── 数据库 ────────────────────────────────────────────────────────────────
if [[ "$DRIVER" == "postgres" ]]; then
  DB_ARTIFACT="wmind-db-$STAMP.dump"
  "${COMPOSE[@]}" exec -T db pg_dump \
    -U "${POSTGRES_USER:-wmind}" \
    -d "${POSTGRES_DB:-wmind}" \
    --format=custom --no-owner \
    >"$BACKUP_DIR/$DB_ARTIFACT"
else
  DB_ARTIFACT="wmind-db-$STAMP.db"
  # 先备份到容器内的 /data，再 cp 出来，最后删掉临时文件：直接 cp 一个
  # 正在被 VACUUM 写入的路径会拿到半成品。
  TMP_IN_CONTAINER="/data/.backup-$STAMP.db"
  "${COMPOSE[@]}" exec -T api /app/wmind db backup --out "$TMP_IN_CONTAINER"
  "${COMPOSE[@]}" cp "api:$TMP_IN_CONTAINER" "$BACKUP_DIR/$DB_ARTIFACT"
  "${COMPOSE[@]}" exec -T api rm -f "$TMP_IN_CONTAINER"
fi

# ── 上传文件（头像、导入的图片）───────────────────────────────────────────
# 卷不存在时 docker run 会自动建一个空卷，于是「备份成功但什么都没备到」。
# 先检查，缺了就明确说出来。
UPLOADS_ARTIFACT=""
if docker volume inspect "$UPLOADS_VOLUME" >/dev/null 2>&1; then
  UPLOADS_ARTIFACT="wmind-uploads-$STAMP.tar.gz"
  docker run --rm \
    -v "$UPLOADS_VOLUME:/src:ro" \
    -v "$BACKUP_DIR:/backup" \
    alpine:3.20 tar czf "/backup/$UPLOADS_ARTIFACT" -C /src .
else
  echo "警告：卷 $UPLOADS_VOLUME 不存在，跳过上传文件备份" >&2
fi

# ── 密钥（可选）────────────────────────────────────────────────────────────
# 数据库备份里没有 JWT 密钥与管理员密码：恢复到一个新机器上还需要 .env，
# 否则所有会话失效、也登不进后台。它含密钥，所以只有显式要求时才一起备份。
ENV_ARTIFACT=""
if [[ "$WITH_ENV" == "1" ]]; then
  if [[ -f .env ]]; then
    ENV_ARTIFACT="wmind-env-$STAMP.txt"
    install -m 600 .env "$BACKUP_DIR/$ENV_ARTIFACT"
    echo "注意：$ENV_ARTIFACT 含 JWT 密钥与数据库密码，请与数据库备份分开保管。" >&2
  else
    echo "警告：--with-env 指定了，但 $DEPLOY_DIR/.env 不存在" >&2
  fi
fi

# ── 清理 ──────────────────────────────────────────────────────────────────
# 只删本脚本产出的前缀，避免把用户自己放进 backups 的东西清掉。
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'wmind-*' -mtime +"$KEEP_DAYS" -delete

echo "备份完成（${DRIVER}）："
echo "  数据库   $BACKUP_DIR/$DB_ARTIFACT"
if [[ -n "$UPLOADS_ARTIFACT" ]]; then
  echo "  上传文件 $BACKUP_DIR/$UPLOADS_ARTIFACT"
fi
if [[ -n "$ENV_ARTIFACT" ]]; then
  echo "  环境变量 $BACKUP_DIR/${ENV_ARTIFACT}（含密钥）"
fi
