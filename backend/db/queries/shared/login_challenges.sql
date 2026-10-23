-- name: CreateLoginChallenge :exec
INSERT INTO login_challenges (hash, identifier_hash, sealed_key, expires_at)
VALUES (sqlc.arg(hash), sqlc.arg(identifier_hash), sqlc.arg(sealed_key), sqlc.arg(expires_at));

-- name: ConsumeLoginChallenge :one
DELETE FROM login_challenges
WHERE hash = sqlc.arg(hash) AND identifier_hash = sqlc.arg(identifier_hash) AND expires_at > sqlc.arg(now)
RETURNING hash, identifier_hash, sealed_key, expires_at;

-- name: DeleteExpiredLoginChallenges :exec
DELETE FROM login_challenges WHERE expires_at <= sqlc.arg(now);
