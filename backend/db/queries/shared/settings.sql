-- settings: queries shared by BOTH dialects.
--
-- ============================================================================
-- ASCII-ONLY FILE. See the header of queries/shared/users.sql for why
-- non-ASCII characters break sqlc's placeholder rewrite.
-- ============================================================================
--
-- One row per key, value is a JSON document. Keys are owned by the settings
-- service, not by the database: unknown keys are rejected there, so this file
-- stays a plain key-value store.
--
-- Read path is "load everything once, cache in memory" (see docs/04 section
-- 7.5): the site config is read on every request, so per-key queries would
-- turn a cached snapshot into N round trips.

-- name: ListSettings :many
SELECT * FROM settings
ORDER BY key;

-- name: GetSetting :one
SELECT * FROM settings
WHERE key = sqlc.arg(key);

-- Upsert keeps the table free of "insert or update" branches in Go, which is
-- where the two dialects would otherwise diverge (SQLite's INSERT OR REPLACE
-- resets columns; PostgreSQL's ON CONFLICT does not).
-- name: UpsertSetting :exec
INSERT INTO settings (key, value, updated_by, updated_at)
VALUES (
  sqlc.arg(key), sqlc.arg(value),
  sqlc.narg(updated_by), sqlc.arg(updated_at)
)
ON CONFLICT (key) DO UPDATE SET
  value = excluded.value,
  updated_by = excluded.updated_by,
  updated_at = excluded.updated_at;
