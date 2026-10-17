-- maps: queries shared by BOTH dialects.
--
-- ============================================================================
-- ASCII-ONLY FILE. See the header of queries/shared/users.sql for why
-- non-ASCII characters break sqlc's placeholder rewrite.
-- ============================================================================
--
-- Every query carries an owner_id predicate: data isolation is enforced at
-- the type level, not by the caller remembering to add it. A cross-user
-- access returns "not found" rather than "forbidden" (docs/01).
--
-- Time is always a parameter, never now(). `version` is the optimistic lock:
-- UpdateMapWithVersion writes only if the client-held version still matches.

-- name: CreateMap :one
INSERT INTO maps (
  uid, owner_id, title, document, version, thumbnail_url,
  node_count, size_bytes, created_at, updated_at
) VALUES (
  sqlc.arg(uid), sqlc.arg(owner_id), sqlc.arg(title), sqlc.arg(document), 1, '',
  sqlc.arg(node_count), sqlc.arg(size_bytes), sqlc.arg(created_at), sqlc.arg(updated_at)
)
RETURNING *;

-- name: GetMapByUID :one
SELECT * FROM maps
WHERE uid = sqlc.arg(uid)
  AND owner_id = sqlc.arg(owner_id)
  AND deleted_at IS NULL;

-- name: ListMapsByOwner :many
SELECT * FROM maps
WHERE owner_id = sqlc.arg(owner_id) AND deleted_at IS NULL
ORDER BY updated_at DESC
LIMIT sqlc.arg(page_size) OFFSET sqlc.arg(row_offset);

-- name: CountMapsByOwner :one
SELECT COUNT(*) FROM maps
WHERE owner_id = sqlc.arg(owner_id) AND deleted_at IS NULL;

-- Optimistic-lock update: writes only when the version still matches, and
-- bumps the version in the same statement.
-- On mismatch the :one query returns sql.ErrNoRows; the repository layer
-- then decides between "map not found" and "version conflict".
-- name: UpdateMapWithVersion :one
UPDATE maps
SET title = sqlc.arg(title),
    document = sqlc.arg(document),
    thumbnail_url = sqlc.arg(thumbnail_url),
    node_count = sqlc.arg(node_count),
    size_bytes = sqlc.arg(size_bytes),
    version = version + 1,
    updated_at = sqlc.arg(updated_at)
WHERE uid = sqlc.arg(uid)
  AND owner_id = sqlc.arg(owner_id)
  AND version = sqlc.arg(expected_version)
  AND deleted_at IS NULL
RETURNING *;

-- name: UpdateMapMeta :one
UPDATE maps
SET title = sqlc.arg(title),
    updated_at = sqlc.arg(updated_at)
WHERE uid = sqlc.arg(uid) AND owner_id = sqlc.arg(owner_id) AND deleted_at IS NULL
RETURNING *;

-- name: UpdateMapThumbnail :execrows
UPDATE maps
SET thumbnail_url = sqlc.arg(thumbnail_url),
    updated_at = sqlc.arg(updated_at)
WHERE uid = sqlc.arg(uid) AND owner_id = sqlc.arg(owner_id) AND deleted_at IS NULL;

-- name: SoftDeleteMap :execrows
UPDATE maps
SET deleted_at = sqlc.arg(deleted_at), updated_at = sqlc.arg(updated_at)
WHERE uid = sqlc.arg(uid) AND owner_id = sqlc.arg(owner_id) AND deleted_at IS NULL;

-- name: RestoreMap :one
UPDATE maps
SET deleted_at = NULL, updated_at = sqlc.arg(updated_at)
WHERE uid = sqlc.arg(uid) AND owner_id = sqlc.arg(owner_id) AND deleted_at IS NOT NULL
RETURNING *;

-- name: ListTrashedMaps :many
SELECT * FROM maps
WHERE owner_id = sqlc.arg(owner_id) AND deleted_at IS NOT NULL
ORDER BY deleted_at DESC
LIMIT sqlc.arg(page_size) OFFSET sqlc.arg(row_offset);

-- name: CountTrashedMaps :one
SELECT COUNT(*) FROM maps
WHERE owner_id = sqlc.arg(owner_id) AND deleted_at IS NOT NULL;

-- name: HardDeleteMap :execrows
DELETE FROM maps
WHERE uid = sqlc.arg(uid) AND owner_id = sqlc.arg(owner_id);

-- name: HardDeleteTrashedMaps :exec
DELETE FROM maps
WHERE owner_id = sqlc.arg(owner_id) AND deleted_at IS NOT NULL;

-- name: ListAllMapsByOwnerIncludingDeleted :many
SELECT * FROM maps
WHERE owner_id = sqlc.arg(owner_id)
ORDER BY created_at ASC;
