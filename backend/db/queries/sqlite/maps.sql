-- SQLite-only queries: method and parameter names correspond one-to-one with
-- queries/postgres/maps.sql.
--
-- ============================================================================
-- ASCII-ONLY FILE. See the header of queries/shared/users.sql for why.
-- ============================================================================
--
-- Only two differences from the PostgreSQL version:
--   1. ILIKE -> LIKE. SQLite's built-in LIKE folds case for ASCII only, so
--      English title search is case-SENSITIVE here while Chinese is exact
--      in both. This is an accepted phase-1 difference (ADR-015).
--   2. FOR UPDATE -> no lock. SQLite has no row locks; write transactions
--      are serialised instead by BEGIN IMMEDIATE plus a single writer
--      connection (SetMaxOpenConns(1)). See docs/04 section 7.9.3 item 4.

-- The three ORDER BY variants mirror queries/shared/maps.sql#ListMapsByOwner
-- exactly; see the comment there for why sorting is not parameterised.
-- name: SearchMapsByTitle :many
SELECT * FROM maps
WHERE owner_id = sqlc.arg(owner_id)
  AND deleted_at IS NULL
  AND title LIKE sqlc.arg(pattern)
ORDER BY updated_at DESC, id DESC
LIMIT sqlc.arg(page_size) OFFSET sqlc.arg(row_offset);

-- name: SearchMapsByTitleName :many
SELECT * FROM maps
WHERE owner_id = sqlc.arg(owner_id)
  AND deleted_at IS NULL
  AND title LIKE sqlc.arg(pattern)
ORDER BY title ASC, id DESC
LIMIT sqlc.arg(page_size) OFFSET sqlc.arg(row_offset);

-- name: SearchMapsByTitleCreated :many
SELECT * FROM maps
WHERE owner_id = sqlc.arg(owner_id)
  AND deleted_at IS NULL
  AND title LIKE sqlc.arg(pattern)
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_size) OFFSET sqlc.arg(row_offset);

-- name: CountMapsByTitle :one
SELECT COUNT(*) FROM maps
WHERE owner_id = sqlc.arg(owner_id)
  AND deleted_at IS NULL
  AND title LIKE sqlc.arg(pattern);

-- Same method name as the PostgreSQL side so the repository can call it
-- identically on both. No FOR UPDATE here: the write transaction is already
-- exclusive thanks to BEGIN IMMEDIATE.
-- name: GetMapForUpdate :one
SELECT * FROM maps
WHERE uid = sqlc.arg(uid)
  AND owner_id = sqlc.arg(owner_id)
  AND deleted_at IS NULL;
