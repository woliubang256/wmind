-- templates: queries shared by BOTH dialects.
--
-- ============================================================================
-- ASCII-ONLY FILE. See the header of queries/shared/users.sql for why
-- non-ASCII characters break sqlc's placeholder rewrite.
-- ============================================================================
--
-- The eight built-in templates are NOT in this table. They are compiled into
-- the client bundle (frontend/src/features/templates/builtin.ts), for exactly
-- the reason the ten palettes live there (see queries/shared/themes.sql and
-- ADR-019):
--
--   1. The picker renders a LIVE PREVIEW of each template. A preview needs the
--      document, so the document has to exist before the dialog can paint --
--      shipping it in the bundle costs one import instead of one round trip.
--   2. The template NAMES are i18n keys (the zh-CN and en-US strings live in
--      the locale files). A TEXT column cannot hold one value that resolves
--      in both locales, so a DB-resident built-in set would be single-language
--      forever.
--   3. The skeleton is built by the same createDocument/createTopic helpers the
--      editor uses, so a new required field in the document model is picked up
--      automatically instead of silently producing an invalid skeleton.
--
-- `is_builtin` and the nullable `owner_id` stay in the schema as the hook for
-- a future admin-managed set, exactly like `themes`.
--
-- Every query carries an owner_id predicate, exactly like maps and themes:
-- isolation is enforced by the SQL, not by the caller remembering to add it.
-- A cross-user access returns "not found" rather than "forbidden".

-- Reads accept built-in rows (owner_id IS NULL) as well as the caller's own,
-- because the schema defines NULL as "built-in, visible to everyone". Today
-- there are never any such rows -- the built-in set is client-side -- but the
-- `OR owner_id IS NULL` keeps TEMPLATE_BUILTIN_READONLY reachable instead of
-- dead: without it a built-in row would be invisible to every user, so the
-- read-only guard in the service could never fire, and an admin-managed set
-- (the whole point of the column) would be silently unreadable.
--
-- Writes below stay owner-only AND is_builtin = false, so a built-in row can
-- never be renamed or deleted.
--
-- `document` is deliberately NOT selected in the list. A template carries a
-- full .wmind document, capped at the same 8 MiB a map allows; the list
-- surface only needs name / structure / thumbnail. Selecting it would make one
-- list request carry every document the user ever saved as a template.
--
-- GetTemplateByUID below is the one place that does read it, and it is called
-- at most once per "use this template" click.
-- name: ListTemplatesByOwner :many
SELECT id, uid, owner_id, name, category, structure, thumbnail_url,
       sort_order, is_builtin, created_at, updated_at
FROM templates
WHERE owner_id = sqlc.arg(owner_id)
   OR owner_id IS NULL
ORDER BY is_builtin DESC, sort_order ASC, created_at ASC, id ASC;

-- name: GetTemplateByUID :one
SELECT * FROM templates
WHERE uid = sqlc.arg(uid)
  AND (owner_id = sqlc.arg(owner_id) OR owner_id IS NULL);

-- The quota counts USER templates only: a built-in row is not the caller's, so
-- charging it against their limit would make the limit shrink under them.
-- name: CountTemplatesByOwner :one
SELECT COUNT(*) FROM templates
WHERE owner_id = sqlc.arg(owner_id);

-- is_builtin is a literal false and sort_order a literal 0: a template created
-- through the API is by definition a user template. Leaving either as a
-- parameter would let a crafted request forge an un-deletable row, or push a
-- user template to the top of every other list it is rendered in.
--
-- thumbnail_url comes from the source map rather than from the request: the
-- picker shows it on the card, and letting a client supply an arbitrary URL
-- would turn the template list into an image proxy.
-- name: CreateTemplate :one
INSERT INTO templates (
  uid, owner_id, name, category, structure, document, thumbnail_url,
  sort_order, is_builtin, created_at, updated_at
) VALUES (
  sqlc.arg(uid), sqlc.arg(owner_id), sqlc.arg(name), sqlc.arg(category),
  sqlc.arg(structure), sqlc.arg(document), sqlc.arg(thumbnail_url), 0, false,
  sqlc.arg(created_at), sqlc.arg(updated_at)
)
RETURNING *;

-- name: RenameTemplate :one
UPDATE templates
SET name = sqlc.arg(name),
    updated_at = sqlc.arg(updated_at)
WHERE uid = sqlc.arg(uid)
  AND owner_id = sqlc.arg(owner_id)
  AND is_builtin = false
RETURNING *;

-- name: DeleteTemplate :execrows
DELETE FROM templates
WHERE uid = sqlc.arg(uid)
  AND owner_id = sqlc.arg(owner_id)
  AND is_builtin = false;
