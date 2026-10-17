-- 0001_init · wmind 初始 schema（SQLite 版本）
--
-- 由 migrations/postgres/0001_init.up.sql 按 docs/03 §3.2.1 的类型映射表逐列派生。
-- 表名、列名、约束名、索引名与 PostgreSQL 版**完全一致**，差异只在四处：
--
--   1. 主键：BIGSERIAL PRIMARY KEY        → INTEGER PRIMARY KEY AUTOINCREMENT
--   2. 外键列：BIGINT                      → INTEGER
--   3. 时间：TIMESTAMPTZ                   → TEXT（ISO-8601 UTC，必须带 Z 后缀）
--   4. 布尔：BOOLEAN                       → INTEGER + CHECK (x IN (0,1))
--
-- 另外 JSONB → TEXT + CHECK (json_valid(...))，INET → TEXT。
--
-- 索引语句与 PostgreSQL 版逐字相同——部分索引与表达式索引 SQLite 都支持。
-- 唯一的例外是 idx_maps_title_trgm（pg_trgm 专有），SQLite 侧不建。
--
-- ⚠️ 时间列的 DEFAULT 只是兜底。业务写入一律由 Go 计算后传参（docs/03 §3.2.3）：
--    strftime('%Y-%m-%dT%H:%M:%fZ','now') 产出的是带 Z 的 UTC，字符串比较
--    即等价于时间比较；若省略 Z 或存本地时间，跨时区比较会**静默出错**。
--
-- ⚠️ SQLite 不支持 ALTER COLUMN。后续版本若要改列类型或约束，必须走
--    「建新表 → INSERT INTO ... SELECT → DROP 旧表 → RENAME」的表重建流程。

-- ── users ────────────────────────────────────────────────────────────────────

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uid           TEXT    NOT NULL UNIQUE,
  username      TEXT    NOT NULL UNIQUE,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  nickname      TEXT    NOT NULL DEFAULT '',
  avatar_url    TEXT    NOT NULL DEFAULT '',
  role          TEXT    NOT NULL DEFAULT 'user',
  status        TEXT    NOT NULL DEFAULT 'active',
  map_count     INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at    TEXT
);

CREATE UNIQUE INDEX uq_users_email_lower ON users (lower(email)) WHERE deleted_at IS NULL;

-- ── maps ─────────────────────────────────────────────────────────────────────

CREATE TABLE maps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uid           TEXT    NOT NULL UNIQUE,
  owner_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT    NOT NULL DEFAULT '未命名导图',
  document      TEXT    NOT NULL CHECK (json_valid(document)),
  version       INTEGER NOT NULL DEFAULT 1,
  thumbnail_url TEXT    NOT NULL DEFAULT '',
  node_count    INTEGER NOT NULL DEFAULT 0,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  deleted_at    TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_maps_owner_updated ON maps (owner_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_maps_owner_deleted ON maps (owner_id, deleted_at)     WHERE deleted_at IS NOT NULL;

-- idx_maps_title_trgm 不在此建立：pg_trgm 为 PostgreSQL 专有。
-- 标题搜索退化为 LIKE '%kw%' 全表扫描，在导图数 < 5000 时代价可忽略。

-- ── templates ────────────────────────────────────────────────────────────────

CREATE TABLE templates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uid           TEXT    NOT NULL UNIQUE,
  owner_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  category      TEXT    NOT NULL,
  structure     TEXT    NOT NULL,
  document      TEXT    NOT NULL CHECK (json_valid(document)),
  thumbnail_url TEXT    NOT NULL DEFAULT '',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_builtin    INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0,1)),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_templates_owner ON templates (owner_id);

-- ── themes ───────────────────────────────────────────────────────────────────

CREATE TABLE themes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  uid        TEXT    NOT NULL UNIQUE,
  owner_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  category   TEXT    NOT NULL,
  config     TEXT    NOT NULL CHECK (json_valid(config)),
  is_builtin INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_themes_owner ON themes (owner_id);

-- ── settings ─────────────────────────────────────────────────────────────────

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL CHECK (json_valid(value)),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ── refresh_tokens ───────────────────────────────────────────────────────────

CREATE TABLE refresh_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT    NOT NULL UNIQUE,
  platform   TEXT    NOT NULL DEFAULT 'web',
  device     TEXT    NOT NULL DEFAULT '',
  expires_at TEXT    NOT NULL,
  revoked_at TEXT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_refresh_user ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- ── user_tokens（二期预留）────────────────────────────────────────────────────

CREATE TABLE user_tokens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT    NOT NULL,
  token_hash TEXT    NOT NULL UNIQUE,
  expires_at TEXT    NOT NULL,
  used_at    TEXT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_user_tokens_user ON user_tokens (user_id, purpose) WHERE used_at IS NULL;

-- ── user_devices ─────────────────────────────────────────────────────────────

CREATE TABLE user_devices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    TEXT    NOT NULL,
  platform     TEXT    NOT NULL,
  app_version  TEXT    NOT NULL DEFAULT '',
  push_token   TEXT    NOT NULL DEFAULT '',
  last_seen_at TEXT,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, device_id)
);

-- ── files ────────────────────────────────────────────────────────────────────

CREATE TABLE files (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uid         TEXT    NOT NULL UNIQUE,
  owner_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL,
  storage_key TEXT    NOT NULL,
  mime_type   TEXT    NOT NULL,
  size_bytes  INTEGER NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_files_owner ON files (owner_id);

-- ── audit_logs ───────────────────────────────────────────────────────────────

CREATE TABLE audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT    NOT NULL,
  target_type TEXT    NOT NULL DEFAULT '',
  target_id   TEXT    NOT NULL DEFAULT '',
  detail      TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(detail)),
  ip          TEXT,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_audit_created ON audit_logs (created_at DESC);

-- ── share_links ──────────────────────────────────────────────────────────────

CREATE TABLE share_links (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  uid            TEXT    NOT NULL UNIQUE,
  token          TEXT    NOT NULL UNIQUE,
  map_id         INTEGER NOT NULL REFERENCES maps(id)  ON DELETE CASCADE,
  owner_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash  TEXT    NOT NULL DEFAULT '',
  allow_download INTEGER NOT NULL DEFAULT 1 CHECK (allow_download IN (0,1)),
  show_notes     INTEGER NOT NULL DEFAULT 1 CHECK (show_notes IN (0,1)),
  expires_at     TEXT,
  view_count     INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT,
  revoked_at     TEXT,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX idx_share_map   ON share_links (map_id)   WHERE revoked_at IS NULL;
CREATE INDEX idx_share_owner ON share_links (owner_id, created_at DESC);

-- ── map_revisions ────────────────────────────────────────────────────────────

CREATE TABLE map_revisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  map_id     INTEGER NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  document   TEXT    NOT NULL CHECK (json_valid(document)),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (map_id, version)
);
