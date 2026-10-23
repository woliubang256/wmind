-- name: EnsureTwoFactor :exec
INSERT INTO user_two_factor (user_id) VALUES (sqlc.arg(user_id)) ON CONFLICT (user_id) DO NOTHING;

-- name: GetTwoFactor :one
SELECT state, revision FROM user_two_factor WHERE user_id = sqlc.arg(user_id);

-- name: SaveTwoFactor :execrows
UPDATE user_two_factor SET state = sqlc.arg(state), revision = revision + 1
WHERE user_id = sqlc.arg(user_id) AND revision = sqlc.arg(revision);
