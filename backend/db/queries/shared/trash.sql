-- Global retention cleanup is deliberately separate from owner-scoped map queries.
-- Recheck the deletion time outside the subquery to preserve concurrent restores.
-- name: PurgeExpiredTrash :execrows
DELETE FROM maps
WHERE maps.deleted_at IS NOT NULL AND maps.deleted_at <= sqlc.arg(cutoff)
  AND maps.id IN (
    SELECT expired.id FROM maps AS expired
    WHERE expired.deleted_at IS NOT NULL AND expired.deleted_at <= sqlc.arg(cutoff)
    ORDER BY expired.deleted_at, expired.id
    LIMIT sqlc.arg(batch_size)
  );
