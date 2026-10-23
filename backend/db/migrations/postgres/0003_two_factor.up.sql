CREATE TABLE user_two_factor (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT '{}',
    revision BIGINT NOT NULL DEFAULT 0
);
