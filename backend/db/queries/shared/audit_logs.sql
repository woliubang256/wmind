-- audit_logs: queries shared by BOTH dialects.
--
-- ============================================================================
-- ASCII-ONLY FILE. See the header of queries/shared/users.sql for why
-- non-ASCII characters break sqlc's placeholder rewrite.
-- ============================================================================
--
-- Append-only. There is deliberately no UPDATE and no DELETE query: an audit
-- trail that the application can rewrite is not an audit trail.
--
-- detail is a JSON document; it must never contain secrets (passwords, token
-- values). The service layer is responsible for that, the column cannot
-- enforce it.

-- name: CreateAuditLog :exec
INSERT INTO audit_logs (
  actor_id, action, target_type, target_id, detail, ip, created_at
) VALUES (
  sqlc.narg(actor_id), sqlc.arg(action), sqlc.arg(target_type),
  sqlc.arg(target_id), sqlc.arg(detail), sqlc.narg(ip), sqlc.arg(created_at)
);

-- name: ListAuditLogs :many
-- Filters are all optional: a NULL argument disables that condition.
--
-- The "col = COALESCE(arg, col)" shape is used instead of the more obvious
-- "arg IS NULL OR col = arg" because the latter makes sqlc infer the parameter
-- type as interface{} (the IS NULL test tells it nothing). COALESCE keeps the
-- comparison against the column, so the parameter gets the column's type.
SELECT * FROM audit_logs
WHERE action = COALESCE(sqlc.narg(action), action)
  AND actor_id = COALESCE(sqlc.narg(actor_id), actor_id)
  AND created_at >= COALESCE(sqlc.narg(from_time), created_at)
  AND created_at <= COALESCE(sqlc.narg(to_time), created_at)
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_size) OFFSET sqlc.arg(row_offset);

-- name: CountAuditLogs :one
-- Same filter set as ListAuditLogs; keep the two in sync or pagination lies.
SELECT COUNT(*) FROM audit_logs
WHERE action = COALESCE(sqlc.narg(action), action)
  AND actor_id = COALESCE(sqlc.narg(actor_id), actor_id)
  AND created_at >= COALESCE(sqlc.narg(from_time), created_at)
  AND created_at <= COALESCE(sqlc.narg(to_time), created_at);
