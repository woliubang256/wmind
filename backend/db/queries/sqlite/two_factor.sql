-- name: GetTwoFactorForUpdate :one
SELECT state, revision FROM user_two_factor WHERE user_id = sqlc.arg(user_id);
