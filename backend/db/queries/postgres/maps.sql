-- PostgreSQL-only queries: these use syntax SQLite cannot express, so they
-- cannot live in queries/shared.
--
-- ============================================================================
-- ASCII-ONLY FILE. See the header of queries/shared/users.sql for why.
-- ============================================================================
--
-- Each file here MUST keep method names and parameter names in exact
-- one-to-one correspondence with the same-named file under queries/sqlite/.
-- The two repository implementations call the same method names, which is
-- what lets the contract test suite run against both dialects unchanged.

-- ILIKE + pg_trgm: case-insensitive for English titles; for Chinese titles
-- both dialects behave identically (exact match). The pg_trgm GIN index
-- (idx_maps_title_trgm) lets the '%kw%' pattern use an index instead of a
-- full scan.
-- name: SearchMapsByTitle :many
SELECT * FROM maps
WHERE owner_id = sqlc.arg(owner_id)
  AND deleted_at IS NULL
  AND title ILIKE sqlc.arg(pattern)
ORDER BY updated_at DESC
LIMIT sqlc.arg(page_size) OFFSET sqlc.arg(row_offset);

-- name: CountMapsByTitle :one
SELECT COUNT(*) FROM maps
WHERE owner_id = sqlc.arg(owner_id)
  AND deleted_at IS NULL
  AND title ILIKE sqlc.arg(pattern);

-- Takes a row lock inside the save transaction.
-- This stacks on top of the optimistic version lock: the optimistic lock
-- stops concurrent requests across time, the row lock stops two requests
-- racing within the same instant.
-- name: GetMapForUpdate :one
SELECT * FROM maps
WHERE uid = sqlc.arg(uid)
  AND owner_id = sqlc.arg(owner_id)
  AND deleted_at IS NULL
FOR UPDATE;
