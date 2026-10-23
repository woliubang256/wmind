-- name: ListAdminTrend :many
SELECT CAST(date(events.created_at) AS TEXT) AS day,
       CAST(SUM(new_users) AS BIGINT) AS new_users,
       CAST(SUM(new_maps) AS BIGINT) AS new_maps
FROM (
  SELECT u.created_at, 1 AS new_users, 0 AS new_maps FROM users u
  WHERE u.created_at >= sqlc.arg(from_at) AND u.created_at < sqlc.arg(until_at)
  UNION ALL
  SELECT m.created_at, 0 AS new_users, 1 AS new_maps FROM maps m
  WHERE m.created_at >= sqlc.arg(from_at) AND m.created_at < sqlc.arg(until_at)
) AS events
GROUP BY date(events.created_at)
ORDER BY day;
