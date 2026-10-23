package domain

import "context"

// TwoFactorState is a versioned private record; never serialize it as an HTTP response.
type TwoFactorState struct {
	Revision         int64 `json:"-"`
	Enabled          bool
	Secret           string
	PendingSecret    string
	PendingExpiresAt int64
	LastCounter      int64
	RecoveryHashes   []string
	SessionVersion   string
	Challenges       []TwoFactorChallenge
}

type TwoFactorChallenge struct {
	Hash         string
	PasswordHash string
	Version      string
	ExpiresAt    int64
	Attempts     int
}

type TwoFactorRepo interface {
	Ensure(context.Context, int64) error
	Get(context.Context, int64, bool) (*TwoFactorState, error)
	Save(context.Context, int64, *TwoFactorState) error
}
