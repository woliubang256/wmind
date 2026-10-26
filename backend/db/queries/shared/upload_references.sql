-- Global maintenance-only references. Soft-deleted maps still own their files.
-- Keep these separate from the owner-scoped public map repository.

-- name: ListUploadMapReferences :many
SELECT id, document, thumbnail_url FROM maps
WHERE id > sqlc.arg(after_id)
ORDER BY id LIMIT 8;

-- name: ListUploadRevisionReferences :many
SELECT id, document FROM map_revisions
WHERE id > sqlc.arg(after_id)
ORDER BY id LIMIT 8;

-- name: ListUploadTemplateReferences :many
SELECT id, document, thumbnail_url FROM templates
WHERE id > sqlc.arg(after_id)
ORDER BY id LIMIT 8;

-- name: ListUploadAvatarReferences :many
SELECT id, avatar_url FROM users
WHERE id > sqlc.arg(after_id) AND deleted_at IS NULL
ORDER BY id LIMIT 100;
