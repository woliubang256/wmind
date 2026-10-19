-- themes: queries shared by BOTH dialects.
--
-- ============================================================================
-- ASCII-ONLY FILE. See the header of queries/shared/users.sql for why
-- non-ASCII characters break sqlc's placeholder rewrite.
-- ============================================================================
--
-- The `themes` table holds USER themes only. The ten built-in palettes are
-- compiled into the client bundle (frontend/src/editor/theme/palettes.json),
-- not seeded here: the editor has to resolve styles on the very first paint,
-- before any request completes, and a second copy of the same data would need
-- its own drift gate. `is_builtin` / `owner_id IS NULL` stay in the schema as
-- the hook for a future admin-managed built-in set (see docs/04 section 5.5).
--
-- Every query carries an owner_id predicate, exactly like maps: isolation is
-- enforced by the SQL, not by the caller remembering to add it. A cross-user
-- access returns "not found" rather than "forbidden".
--
-- `config` is a whole Theme object. It is stored as JSONB on PostgreSQL and
-- TEXT + json_valid on SQLite; the service layer owns its meaning, so adding
-- a field to Theme never needs a migration.

-- name: ListThemesByOwner :many
SELECT * FROM themes
WHERE owner_id = sqlc.arg(owner_id)
ORDER BY sort_order ASC, created_at ASC;

-- name: GetThemeByUID :one
SELECT * FROM themes
WHERE uid = sqlc.arg(uid)
  AND owner_id = sqlc.arg(owner_id);

-- name: CountThemesByOwner :one
SELECT COUNT(*) FROM themes
WHERE owner_id = sqlc.arg(owner_id);

-- is_builtin is a literal false: a theme created through the API is by
-- definition a user theme. Leaving it as a parameter would let a crafted
-- request forge an un-deletable built-in row.
-- name: CreateTheme :one
INSERT INTO themes (
  uid, owner_id, name, category, config, is_builtin, sort_order,
  created_at, updated_at
) VALUES (
  sqlc.arg(uid), sqlc.arg(owner_id), sqlc.arg(name), sqlc.arg(category),
  sqlc.arg(config), false, 0, sqlc.arg(created_at), sqlc.arg(updated_at)
)
RETURNING *;

-- name: UpdateTheme :one
UPDATE themes
SET name = sqlc.arg(name),
    config = sqlc.arg(config),
    updated_at = sqlc.arg(updated_at)
WHERE uid = sqlc.arg(uid)
  AND owner_id = sqlc.arg(owner_id)
  AND is_builtin = false
RETURNING *;

-- name: DeleteTheme :execrows
DELETE FROM themes
WHERE uid = sqlc.arg(uid)
  AND owner_id = sqlc.arg(owner_id)
  AND is_builtin = false;
