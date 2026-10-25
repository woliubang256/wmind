-- share_links: queries shared by BOTH dialects.
--
-- ============================================================================
-- ASCII-ONLY FILE. See the header of queries/shared/users.sql for why
-- non-ASCII characters break sqlc's placeholder rewrite.
-- ============================================================================
--
-- Every read joins `maps`. The join is an INNER JOIN, not a LEFT JOIN: map_id
-- carries ON DELETE CASCADE, so a share row can never outlive its map row.
-- The join exists because every list surface needs the map title (a share list
-- without titles is a list of random tokens) and because the public read needs
-- the document. Joining everywhere keeps one shape for the row mapper instead
-- of two near-identical ones.
--
-- Revoked rows are kept: `revoked_at` is set, the row stays, so view statistics
-- survive a revocation. Callers must therefore filter on revoked_at when the
-- meaning is "still usable" rather than "ever existed".
--
-- Time is always a parameter, never now().

-- name: CreateShare :one
INSERT INTO share_links (
  uid, token, map_id, owner_id, password_hash, password_ciphertext, allow_download, show_notes,
  expires_at, created_at
) VALUES (
  sqlc.arg(uid), sqlc.arg(token), sqlc.arg(map_id), sqlc.arg(owner_id),
  sqlc.arg(password_hash), sqlc.arg(password_ciphertext), sqlc.arg(allow_download), sqlc.arg(show_notes),
  sqlc.narg(expires_at), sqlc.arg(created_at)
)
RETURNING *;

-- name: GetShareByUID :one
SELECT s.id, s.uid, s.token, s.map_id, s.owner_id, s.password_hash, s.password_ciphertext,
       s.allow_download, s.show_notes, s.expires_at, s.view_count,
       s.last_viewed_at, s.revoked_at, s.created_at,
       m.uid AS map_uid, m.title AS map_title
FROM share_links s
JOIN maps m ON m.id = s.map_id
WHERE s.uid = sqlc.arg(uid) AND s.owner_id = sqlc.arg(owner_id);

-- name: GetShareByToken :one
-- The public read path. Returns the document in the same round trip: a second
-- Never reads password_ciphertext: only owner-scoped management needs it.
-- query would double the latency of the only request an anonymous visitor ever
-- makes, and would let the two reads disagree if the map is saved in between.
--
-- `m.deleted_at` is selected so the caller can fold "map in trash" into the
-- same not-found answer as "token revoked".
--
-- The users join requires a live, active owner and supplies the NICKNAME only.
-- A disabled or deleted owner has no public access, including password verify.
-- uid and email must never
-- reach the public payload (docs/04 5.7), so they are not selected at all --
-- a column that is not read cannot be leaked by a later DTO edit.
SELECT s.id, s.uid, s.token, s.map_id, s.owner_id, s.password_hash,
       s.allow_download, s.show_notes, s.expires_at, s.view_count,
       s.last_viewed_at, s.revoked_at, s.created_at,
       m.uid AS map_uid, m.title AS map_title, m.document AS map_document,
       m.deleted_at AS map_deleted_at, u.nickname AS owner_nickname
FROM share_links s
JOIN maps m ON m.id = s.map_id
JOIN users u ON u.id = s.owner_id
WHERE s.token = sqlc.arg(token)
  AND u.status = 'active' AND u.deleted_at IS NULL;

-- name: ListSharesByMap :many
-- Includes revoked rows: the per-map dialog shows history, and hiding revoked
-- links would make "revoke" look like "delete" to the user.
--
-- `id DESC` breaks ties on created_at (millisecond resolution), otherwise a
-- burst of links created in the same millisecond paginates non-deterministically.
SELECT s.id, s.uid, s.token, s.map_id, s.owner_id, s.password_hash, s.password_ciphertext,
       s.allow_download, s.show_notes, s.expires_at, s.view_count,
       s.last_viewed_at, s.revoked_at, s.created_at,
       m.uid AS map_uid, m.title AS map_title
FROM share_links s
JOIN maps m ON m.id = s.map_id
WHERE s.map_id = sqlc.arg(map_id) AND s.owner_id = sqlc.arg(owner_id)
ORDER BY s.created_at DESC, s.id DESC;

-- name: ListSharesByOwner :many
-- The "my shares" page. The map_uid filter is optional; COALESCE keeps the
-- comparison against the column so sqlc infers a real type instead of
-- interface{} (see audit_logs.sql for the same trick).
SELECT s.id, s.uid, s.token, s.map_id, s.owner_id, s.password_hash, s.password_ciphertext,
       s.allow_download, s.show_notes, s.expires_at, s.view_count,
       s.last_viewed_at, s.revoked_at, s.created_at,
       m.uid AS map_uid, m.title AS map_title
FROM share_links s
JOIN maps m ON m.id = s.map_id
WHERE s.owner_id = sqlc.arg(owner_id)
  AND m.uid = COALESCE(sqlc.narg(map_uid), m.uid)
ORDER BY s.created_at DESC, s.id DESC
LIMIT sqlc.arg(page_size) OFFSET sqlc.arg(row_offset);

-- name: CountSharesByOwner :one
-- Same filter set as ListSharesByOwner; keep the two in sync or pagination lies.
SELECT COUNT(*)
FROM share_links s
JOIN maps m ON m.id = s.map_id
WHERE s.owner_id = sqlc.arg(owner_id)
  AND m.uid = COALESCE(sqlc.narg(map_uid), m.uid);

-- name: CountActiveSharesByMap :one
-- Only counts links that still work: the cap exists to bound the number of
-- reachable URLs, and a revoked link is not reachable.
SELECT COUNT(*) FROM share_links
WHERE map_id = sqlc.arg(map_id) AND revoked_at IS NULL;

-- A full write of every mutable column, not a partial patch.
--
-- Partial updates need to distinguish "field absent" from "set to null", and
-- the CASE expressions that would express that are exactly what sqlc's SQLite
-- engine fails to rewrite (see the ORDER BY note in queries/shared/maps.sql).
-- The service reads the row, merges, and writes everything back. The two
-- statements are not atomic, so two concurrent PATCHes on the same link are
-- last-write-wins; the fields are independent toggles flipped by one person
-- from one dialog, so the practical impact is nil.
--
-- The `revoked_at IS NULL` guard means a revoked link cannot be resurrected by
-- patching it.
-- name: UpdateShare :one
UPDATE share_links
SET password_hash = sqlc.arg(password_hash),
    password_ciphertext = sqlc.arg(password_ciphertext),
    allow_download = sqlc.arg(allow_download),
    show_notes = sqlc.arg(show_notes),
    expires_at = sqlc.narg(expires_at)
WHERE uid = sqlc.arg(uid) AND owner_id = sqlc.arg(owner_id) AND revoked_at IS NULL
RETURNING *;

-- name: RevokeShare :execrows
-- Soft revoke. `revoked_at IS NULL` makes the statement idempotent: a second
-- revoke affects zero rows and the caller reports "not found" rather than
-- silently succeeding.
UPDATE share_links
SET revoked_at = sqlc.arg(revoked_at)
WHERE uid = sqlc.arg(uid) AND owner_id = sqlc.arg(owner_id) AND revoked_at IS NULL;

-- name: RecordShareView :exec
-- Called only when the caller decided this visit is outside the dedup window.
UPDATE share_links
SET view_count = view_count + 1, last_viewed_at = sqlc.arg(viewed_at)
WHERE id = sqlc.arg(id);
