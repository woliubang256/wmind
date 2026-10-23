-- name: ListAdminTrend :many
SELECT to_char(events.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
       SUM(new_users)::bigint AS new_users,
       SUM(new_maps)::bigint AS new_maps
FROM (
  SELECT u.created_at, 1 AS new_users, 0 AS new_maps FROM users u
  WHERE u.created_at >= sqlc.arg(from_at) AND u.created_at < sqlc.arg(until_at)
  UNION ALL
  SELECT m.created_at, 0 AS new_users, 1 AS new_maps FROM maps m
  WHERE m.created_at >= sqlc.arg(from_at) AND m.created_at < sqlc.arg(until_at)
) AS events
GROUP BY to_char(events.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')
ORDER BY day;
