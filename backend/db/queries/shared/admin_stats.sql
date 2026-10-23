-- name: GetAdminTotals :one
SELECT
  (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL) AS user_count,
  (SELECT COUNT(*) FROM users WHERE deleted_at IS NULL AND status = 'active') AS active_user_count,
  (SELECT COUNT(*) FROM maps WHERE deleted_at IS NULL) AS map_count,
  CAST(COALESCE((SELECT SUM(size_bytes) FROM maps), 0) AS BIGINT) AS storage_used_bytes;
