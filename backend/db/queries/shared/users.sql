-- users: queries shared by BOTH dialects.
--
-- ============================================================================
-- ASCII-ONLY FILE. Do not put non-ASCII characters in this file.
--
-- sqlc rewrites `sqlc.arg(name)` into the engine's placeholder (`$1` for
-- PostgreSQL, `?1` for SQLite) by splicing the query text at byte offsets.
-- That splice is not multi-byte aware: any non-ASCII character in the SAME
-- statement (a comment above it, or a string literal inside it) shifts the
-- offsets and sqlc emits corrupted SQL, e.g. `UPDATE m?3` or `SELEid`.
-- The failure is deterministic and the error messages are misleading
-- ("syntax error at or near limit", "missing query type"), so keep this
-- file pure ASCII. Rationale and the full repro live in
-- docs/04 section 7.9 and .agents/notes/implemented/architecture/.
-- ============================================================================
--
-- Conventions enforced here:
--   1. Named parameters via sqlc.arg(name) -- never `$1`, never `?`.
--      That is the only reason one file can satisfy both engines.
--   2. Time is always passed in as a parameter (created_at / updated_at /
--      last_login_at / deleted_at). Never call now() or strftime() in SQL.
--      See docs/03 section 3.2.3 discipline #1.
--   3. Email and username are compared case-insensitively via lower(), to
--      match the uq_users_email_lower unique index. Otherwise the index and
--      the lookup disagree and a duplicate slips through.

-- name: CreateUser :one
INSERT INTO users (
  uid, username, email, password_hash, nickname, avatar_url,
  role, status, map_count, created_at, updated_at
) VALUES (
  sqlc.arg(uid), sqlc.arg(username), sqlc.arg(email), sqlc.arg(password_hash),
  sqlc.arg(nickname), sqlc.arg(avatar_url), sqlc.arg(role), sqlc.arg(status),
  0, sqlc.arg(created_at), sqlc.arg(updated_at)
)
RETURNING *;

-- name: GetUserByID :one
SELECT * FROM users
WHERE id = sqlc.arg(id) AND deleted_at IS NULL;

-- name: GetUserByUID :one
SELECT * FROM users
WHERE uid = sqlc.arg(uid) AND deleted_at IS NULL;

-- name: GetUserByEmail :one
SELECT * FROM users
WHERE lower(email) = lower(sqlc.arg(email)) AND deleted_at IS NULL;

-- name: GetUserByUsername :one
SELECT * FROM users
WHERE lower(username) = lower(sqlc.arg(username)) AND deleted_at IS NULL;

-- Login path: include soft-deleted rows so the caller can tell
-- "wrong password" apart from "account was deleted".
-- name: GetUserByEmailIncludingDeleted :one
SELECT * FROM users
WHERE lower(email) = lower(sqlc.arg(email));

-- name: CountUsers :one
SELECT COUNT(*) FROM users
WHERE deleted_at IS NULL;

-- Guards the "last admin" invariant: demoting or deleting the final active
-- admin must be refused (ADMIN_LAST_ADMIN).
-- name: CountActiveAdmins :one
SELECT COUNT(*) FROM users
WHERE role = 'admin' AND status = 'active' AND deleted_at IS NULL;

-- name: ListUsers :many
SELECT * FROM users
WHERE deleted_at IS NULL
  AND (
    sqlc.arg(keyword) = ''
    OR lower(username) LIKE lower(sqlc.arg(keyword))
    OR lower(email) LIKE lower(sqlc.arg(keyword))
    OR lower(nickname) LIKE lower(sqlc.arg(keyword))
  )
  AND (sqlc.arg(role) = '' OR role = sqlc.arg(role))
  AND (sqlc.arg(status) = '' OR status = sqlc.arg(status))
ORDER BY created_at DESC
LIMIT sqlc.arg(page_size) OFFSET sqlc.arg(row_offset);

-- name: CountUsersFiltered :one
SELECT COUNT(*) FROM users
WHERE deleted_at IS NULL
  AND (
    sqlc.arg(keyword) = ''
    OR lower(username) LIKE lower(sqlc.arg(keyword))
    OR lower(email) LIKE lower(sqlc.arg(keyword))
    OR lower(nickname) LIKE lower(sqlc.arg(keyword))
  )
  AND (sqlc.arg(role) = '' OR role = sqlc.arg(role))
  AND (sqlc.arg(status) = '' OR status = sqlc.arg(status));

-- name: UpdateUserProfile :one
UPDATE users
SET nickname = sqlc.arg(nickname),
    avatar_url = sqlc.arg(avatar_url),
    updated_at = sqlc.arg(updated_at)
WHERE uid = sqlc.arg(uid) AND deleted_at IS NULL
RETURNING *;

-- name: UpdateUserPassword :execrows
UPDATE users
SET password_hash = sqlc.arg(password_hash),
    updated_at = sqlc.arg(updated_at)
WHERE id = sqlc.arg(id) AND deleted_at IS NULL;

-- name: UpdateUserStatus :one
UPDATE users
SET status = sqlc.arg(status),
    updated_at = sqlc.arg(updated_at)
WHERE uid = sqlc.arg(uid) AND deleted_at IS NULL
RETURNING *;

-- name: UpdateUserRole :one
UPDATE users
SET role = sqlc.arg(role),
    updated_at = sqlc.arg(updated_at)
WHERE uid = sqlc.arg(uid) AND deleted_at IS NULL
RETURNING *;

-- name: TouchUserLastLogin :execrows
UPDATE users
SET last_login_at = sqlc.arg(last_login_at),
    updated_at = sqlc.arg(updated_at)
WHERE id = sqlc.arg(id);

-- Soft delete. The email and username are renamed in the same statement to
-- release the UNIQUE constraints -- otherwise deleting user A permanently
-- blocks anyone from registering A's address.
-- name: SoftDeleteUser :execrows
UPDATE users
SET deleted_at = sqlc.arg(deleted_at),
    updated_at = sqlc.arg(updated_at),
    email = email || '.deleted.' || sqlc.arg(uid),
    username = username || '.deleted.' || sqlc.arg(uid)
WHERE uid = sqlc.arg(uid) AND deleted_at IS NULL;

-- name: IncrementUserMapCount :execrows
UPDATE users
SET map_count = map_count + sqlc.arg(delta),
    updated_at = sqlc.arg(updated_at)
WHERE id = sqlc.arg(id);
