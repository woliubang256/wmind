-- 0001_init · wmind 初始 schema（PostgreSQL 规范版本）
--
-- 本文件是两套迁移集的**规范版本**。SQLite 版本（migrations/sqlite/0001_init.up.sql）
-- 按 docs/03-数据模型与文件格式.md §3.2.1 的类型映射表逐列派生。
--
-- 铁律：两套迁移集的**表名、列名、约束名、索引名必须完全一致**，只有类型与
-- 极少数语法允许不同。这不是为了好看——`cmd/verifyparity` 要拿两个真实数据库
-- introspect 出来的结构做机械比对，名字一旦漂移，闸门就只能靠人眼 review。
--
-- 时间的处理约定：所有时间列都带 DEFAULT 作为兜底，但**业务写入一律由 Go 计算
-- 后作为参数传入**，禁止在业务查询里调用 now() / interval / date_trunc。
-- 这条纪律消除的正是最隐蔽的一类方言差异（见 docs/03 §3.2.3）。

-- 标题模糊搜索依赖 pg_trgm。需要超级用户权限——compose 里的 POSTGRES_USER
-- 就是该实例的超级用户，因此开箱可用。
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ── users ────────────────────────────────────────────────────────────────────

CREATE TABLE users (
  id            BIGSERIAL   PRIMARY KEY,
  uid           TEXT        NOT NULL UNIQUE,          -- 对外暴露的 ULID，避免自增 ID 泄露规模
  username      TEXT        NOT NULL UNIQUE,
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  nickname      TEXT        NOT NULL DEFAULT '',
  avatar_url    TEXT        NOT NULL DEFAULT '',
  role          TEXT        NOT NULL DEFAULT 'user',  -- user | admin
  status        TEXT        NOT NULL DEFAULT 'active',-- active | disabled（pending 为二期邮箱验证预留）
  map_count     INTEGER     NOT NULL DEFAULT 0,       -- 冗余计数，避免列表页 N+1
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);

-- 邮箱唯一性按小写比较：不区分大小写是用户的直觉预期，
-- 而列上的 UNIQUE 是大小写敏感的，两者互补。
CREATE UNIQUE INDEX uq_users_email_lower ON users (lower(email)) WHERE deleted_at IS NULL;

-- ── maps ─────────────────────────────────────────────────────────────────────

CREATE TABLE maps (
  id            BIGSERIAL   PRIMARY KEY,
  uid           TEXT        NOT NULL UNIQUE,
  owner_id      BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT        NOT NULL DEFAULT '未命名导图',
  document      JSONB       NOT NULL,                 -- 完整 .wmind 文档
  version       INTEGER     NOT NULL DEFAULT 1,       -- 乐观锁
  thumbnail_url TEXT        NOT NULL DEFAULT '',
  node_count    INTEGER     NOT NULL DEFAULT 0,       -- 保存时顺带写入，避免列表页实时解析 JSON
  size_bytes    BIGINT      NOT NULL DEFAULT 0,
  deleted_at    TIMESTAMPTZ,                          -- 非空即视为回收站内容
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_maps_owner_updated ON maps (owner_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_maps_owner_deleted ON maps (owner_id, deleted_at)     WHERE deleted_at IS NOT NULL;

-- PostgreSQL 专有：SQLite 侧不建此索引，标题搜索退化为 LIKE 全表扫描。
-- 这是 docs/04 §7.9.3 方言落点清单里的第 3 项，也是 verify-migration-parity
-- 的唯一一条显式例外（见 cmd/verifyparity）。
CREATE INDEX idx_maps_title_trgm ON maps USING gin (title gin_trgm_ops);

-- ── templates ────────────────────────────────────────────────────────────────

CREATE TABLE templates (
  id            BIGSERIAL   PRIMARY KEY,
  uid           TEXT        NOT NULL UNIQUE,
  owner_id      BIGINT      REFERENCES users(id) ON DELETE CASCADE,  -- NULL = 内置
  name          TEXT        NOT NULL,
  category      TEXT        NOT NULL,                 -- basic | user
  structure     TEXT        NOT NULL,
  document      JSONB       NOT NULL,                 -- 模板骨架（一份合法 .wmind）
  thumbnail_url TEXT        NOT NULL DEFAULT '',
  sort_order    INTEGER     NOT NULL DEFAULT 0,
  is_builtin    BOOLEAN     NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_templates_owner ON templates (owner_id);

-- ── themes ───────────────────────────────────────────────────────────────────

CREATE TABLE themes (
  id         BIGSERIAL   PRIMARY KEY,
  uid        TEXT        NOT NULL UNIQUE,
  owner_id   BIGINT      REFERENCES users(id) ON DELETE CASCADE,     -- NULL = 内置
  name       TEXT        NOT NULL,
  category   TEXT        NOT NULL,                    -- vivid | classic | custom
  config     JSONB       NOT NULL,                    -- Theme 对象
  is_builtin BOOLEAN     NOT NULL DEFAULT false,
  sort_order INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_themes_owner ON themes (owner_id);

-- ── settings（全局键值）───────────────────────────────────────────────────────

CREATE TABLE settings (
  key        TEXT        PRIMARY KEY,
  value      JSONB       NOT NULL,
  updated_by BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── refresh_tokens ───────────────────────────────────────────────────────────

CREATE TABLE refresh_tokens (
  id         BIGSERIAL   PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT        NOT NULL UNIQUE,             -- SHA-256，绝不存明文
  platform   TEXT        NOT NULL DEFAULT 'web',      -- web | ios | android | desktop（客户端预留）
  device     TEXT        NOT NULL DEFAULT '',         -- UA 摘要，用于「登录设备」列表
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_user ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- ── user_tokens（二期预留：密码重置 / 邮箱验证）────────────────────────────────
--
-- 一期建表但**没有任何写入路径**。建表是为了二期接入邮件能力时不必改表结构，
-- 也便于提前固化语义：表名与 purpose 取值一经确定即为契约，二期不得改名。

CREATE TABLE user_tokens (
  id         BIGSERIAL   PRIMARY KEY,
  user_id    BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose    TEXT        NOT NULL,                    -- password_reset | email_verify
  token_hash TEXT        NOT NULL UNIQUE,             -- SHA-256，不存明文
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_tokens_user ON user_tokens (user_id, purpose) WHERE used_at IS NULL;

-- ── user_devices（本期建表，暂不写入）─────────────────────────────────────────

CREATE TABLE user_devices (
  id           BIGSERIAL   PRIMARY KEY,
  user_id      BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id    TEXT        NOT NULL,
  platform     TEXT        NOT NULL,                  -- ios | android | desktop
  app_version  TEXT        NOT NULL DEFAULT '',
  push_token   TEXT        NOT NULL DEFAULT '',
  last_seen_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, device_id)
);

-- ── files ────────────────────────────────────────────────────────────────────

CREATE TABLE files (
  id          BIGSERIAL   PRIMARY KEY,
  uid         TEXT        NOT NULL UNIQUE,
  owner_id    BIGINT      REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT        NOT NULL,                   -- avatar | map-image | thumbnail
  storage_key TEXT        NOT NULL,                   -- 存储后端内的相对路径 / object key
  mime_type   TEXT        NOT NULL,
  size_bytes  BIGINT      NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_files_owner ON files (owner_id);

-- ── audit_logs ───────────────────────────────────────────────────────────────

CREATE TABLE audit_logs (
  id          BIGSERIAL   PRIMARY KEY,
  actor_id    BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT        NOT NULL,                   -- user.disable / settings.update / user.delete ...
  target_type TEXT        NOT NULL DEFAULT '',
  target_id   TEXT        NOT NULL DEFAULT '',
  detail      JSONB       NOT NULL DEFAULT '{}',
  ip          INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_created ON audit_logs (created_at DESC);

-- ── share_links ──────────────────────────────────────────────────────────────
--
-- token 存明文而非哈希：「我的分享」页需要让创建者随时复制回完整链接。
-- 分享令牌是只读访问凭证而非用户凭据，泄露后果有限且随时可撤销；
-- 代价由「默认 noindex / 可设密码 / 可设有效期 / 可随时撤销」四道约束兜住。
-- 注意访问密码（password_hash）仍用 bcrypt，不可逆。

CREATE TABLE share_links (
  id             BIGSERIAL   PRIMARY KEY,
  uid            TEXT        NOT NULL UNIQUE,         -- 管理用标识（对外接口使用）
  token          TEXT        NOT NULL UNIQUE,         -- URL 中使用，≥ 22 字符（≥128 bit 熵）
  map_id         BIGINT      NOT NULL REFERENCES maps(id)  ON DELETE CASCADE,
  owner_id       BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash  TEXT        NOT NULL DEFAULT '',     -- bcrypt；空串表示无访问密码
  allow_download BOOLEAN     NOT NULL DEFAULT true,
  show_notes     BOOLEAN     NOT NULL DEFAULT true,
  expires_at     TIMESTAMPTZ,                         -- NULL = 永久有效
  view_count     BIGINT      NOT NULL DEFAULT 0,
  last_viewed_at TIMESTAMPTZ,
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_share_map   ON share_links (map_id)   WHERE revoked_at IS NULL;
CREATE INDEX idx_share_owner ON share_links (owner_id, created_at DESC);

-- ── map_revisions（P2，先建表不启用）──────────────────────────────────────────

CREATE TABLE map_revisions (
  id         BIGSERIAL   PRIMARY KEY,
  map_id     BIGINT      NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  version    INTEGER     NOT NULL,
  document   JSONB       NOT NULL,
  created_by BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (map_id, version)
);
