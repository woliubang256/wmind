package domain

import "context"

// LoginChallenge is private, short-lived transport state. Hashes are SHA-256;
// ExpiresAt is Unix milliseconds. Never serialize this record to clients.
type LoginChallenge struct {
	Hash           string
	IdentifierHash string
	SealedKey      string
	ExpiresAt      int64
}

type LoginChallengeRepo interface {
	Create(context.Context, LoginChallenge, int64) error
	// Consume atomically deletes and returns a matching unexpired challenge.
	Consume(ctx context.Context, hash, identifierHash string, now int64) (*LoginChallenge, error)
}
