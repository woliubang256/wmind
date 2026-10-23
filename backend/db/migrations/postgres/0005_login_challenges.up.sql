CREATE TABLE login_challenges (
    hash TEXT PRIMARY KEY NOT NULL,
    identifier_hash TEXT NOT NULL,
    sealed_key TEXT NOT NULL,
    expires_at BIGINT NOT NULL
);
CREATE INDEX idx_login_challenges_expires ON login_challenges(expires_at);
