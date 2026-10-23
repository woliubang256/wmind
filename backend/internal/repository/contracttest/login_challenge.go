package contracttest

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/oklog/ulid/v2"
	"github.com/woliubang256/wmind/backend/internal/domain"
)

func RunLoginChallenges(t *testing.T, repo domain.LoginChallengeRepo, tx domain.TxManager) {
	t.Helper()
	ctx, now := t.Context(), time.Now().UnixMilli()
	create := func(expiry int64) domain.LoginChallenge {
		t.Helper()
		v := domain.LoginChallenge{Hash: ulid.Make().String(), IdentifierHash: "account-hash", SealedKey: "sealed-key", ExpiresAt: expiry}
		if err := repo.Create(ctx, v, now); err != nil {
			t.Fatal(err)
		}
		return v
	}
	t.Run("account binding and one-time consumption", func(t *testing.T) {
		v := create(now + 120000)
		if _, err := repo.Consume(ctx, v.Hash, "other-account", now); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("wrong account: %v", err)
		}
		got, err := repo.Consume(ctx, v.Hash, v.IdentifierHash, now)
		if err != nil || *got != v {
			t.Fatalf("roundtrip: %v %v", got, err)
		}
		if _, err := repo.Consume(ctx, v.Hash, v.IdentifierHash, now); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("replay: %v", err)
		}
	})
	t.Run("expiry boundary and cleanup", func(t *testing.T) {
		v := create(now)
		if _, err := repo.Consume(ctx, v.Hash, v.IdentifierHash, now); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("expired challenge: %v", err)
		}
		_ = create(now + 120000) // Prunes expired rows; a backwards test clock must not resurrect them.
		if _, err := repo.Consume(ctx, v.Hash, v.IdentifierHash, now-1); !errors.Is(err, domain.ErrNotFound) {
			t.Fatalf("expired row not pruned: %v", err)
		}
	})
	t.Run("concurrent consumers have exactly one winner", func(t *testing.T) {
		v := create(now + 120000)
		var winners atomic.Int64
		var wg sync.WaitGroup
		for range 12 {
			wg.Go(func() {
				_, err := repo.Consume(ctx, v.Hash, v.IdentifierHash, now)
				if err == nil {
					winners.Add(1)
				} else if !errors.Is(err, domain.ErrNotFound) {
					t.Errorf("concurrent consume: %v", err)
				}
			})
		}
		wg.Wait()
		if winners.Load() != 1 {
			t.Fatalf("winners: %d", winners.Load())
		}
	})
	t.Run("transaction rollback restores consumption", func(t *testing.T) {
		v := create(now + 120000)
		abort := errors.New("abort")
		err := tx.WithTx(ctx, func(ctx context.Context) error {
			if _, err := repo.Consume(ctx, v.Hash, v.IdentifierHash, now); err != nil {
				return err
			}
			return abort
		})
		if !errors.Is(err, abort) {
			t.Fatal(err)
		}
		if _, err := repo.Consume(ctx, v.Hash, v.IdentifierHash, now); err != nil {
			t.Fatalf("rollback: %v", err)
		}
	})
}
