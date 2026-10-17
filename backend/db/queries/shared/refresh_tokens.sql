-- refresh_tokens: queries shared by BOTH dialects.
--
-- ============================================================================
-- ASCII-ONLY FILE. See the header of queries/shared/users.sql for why
-- non-ASCII characters break sqlc's placeholder rewrite.
-- ============================================================================
--
-- Token rows are long-lived sessions (default 7 days). The plaintext token is
-- never stored: token_hash is SHA-256 of the random string handed to the
-- client, so a database leak does not hand out usable sessions.
--
-- Revocation is soft (revoked_at), because the "reuse detection" path needs to
-- tell "never existed" from "already rotated": a rotated token coming back is
-- a signal that the token was stolen, and the whole user's session set must be
-- revoked. Hard-deleting the row would erase that evidence.
--
-- Time is always a parameter, never now().

-- name: CreateRefreshToken :one
INSERT INTO refresh_tokens (
  user_id, token_hash, platform, device, expires_at, created_at
) VALUES (
  sqlc.arg(user_id), sqlc.arg(token_hash), sqlc.arg(platform),
  sqlc.arg(device), sqlc.arg(expires_at), sqlc.arg(created_at)
)
RETURNING *;

-- name: GetRefreshTokenByHash :one
SELECT * FROM refresh_tokens
WHERE token_hash = sqlc.arg(token_hash);

-- Returns the number of rows actually revoked, so the caller can tell
-- "revoked now" from "already revoked or unknown" without a second query.
-- name: RevokeRefreshToken :execrows
UPDATE refresh_tokens
SET revoked_at = sqlc.arg(revoked_at)
WHERE token_hash = sqlc.arg(token_hash) AND revoked_at IS NULL;

-- name: RevokeUserRefreshTokens :execrows
UPDATE refresh_tokens
SET revoked_at = sqlc.arg(revoked_at)
WHERE user_id = sqlc.arg(user_id) AND revoked_at IS NULL;

-- Used after a password change: keep the current device logged in, drop the
-- rest. The caller passes the hash of the token that made the request.
-- name: RevokeUserRefreshTokensExcept :execrows
UPDATE refresh_tokens
SET revoked_at = sqlc.arg(revoked_at)
WHERE user_id = sqlc.arg(user_id)
  AND revoked_at IS NULL
  AND token_hash <> sqlc.arg(keep_token_hash);

-- Housekeeping: rows past expiry are useless, but only rows that are also
-- revoked or expired may go, so an audit of "who logged in when" stays
-- possible within the retention window.
-- name: DeleteExpiredRefreshTokens :execrows
DELETE FROM refresh_tokens
WHERE expires_at < sqlc.arg(before);
