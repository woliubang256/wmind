-- Usernames are looked up case-insensitively (GetUserByUsername uses lower()),
-- but the 0001 schema only had a case-sensitive UNIQUE(username). Without this
-- index, "Alice" and "alice" could both exist, and the lookup would return an
-- arbitrary one of them.
--
-- Partial index on deleted_at IS NULL matches SoftDeleteUser, which renames the
-- username to "<name>.deleted.<uid>" to release the constraint.
CREATE UNIQUE INDEX uq_users_username_lower ON users (lower(username)) WHERE deleted_at IS NULL;
