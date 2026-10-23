package postgres

import (
	"context"
	"io"
	"log/slog"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/oklog/ulid/v2"
	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/migrate"
)

// PostgreSQL's DELETE must recheck deleted_at after a concurrent UPDATE releases
// its row lock. An ID-only outer WHERE would remove the restored/re-deleted map
// because the candidate subquery still sees the old, expired MVCC snapshot.
func TestTrashRetentionConcurrentRestore(t *testing.T) {
	url := os.Getenv("WMIND_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("WMIND_TEST_DATABASE_URL not set")
	}
	pool, err := Connect(t.Context(), url, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	db, err := OpenForMigration(url)
	if err != nil {
		t.Fatal(err)
	}
	if err := migrate.Up("postgres", db, slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	cutoff := time.Date(2024, 1, 1, 12, 0, 0, 0, time.UTC)
	users, maps, trash := NewUserRepository(pool), NewMapRepository(pool), NewTrashRepository(pool)
	for _, redelete := range []bool{false, true} {
		name := "restored"
		if redelete {
			name = "deleted_again_with_new_retention_interval"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			uid := "trashrace" + ulid.Make().String()
			owner, err := users.Create(ctx, domain.CreateUserInput{
				UID: uid, Username: uid, Email: uid + "@example.test", PasswordHash: "hash",
				Role: domain.RoleUser, Status: domain.UserStatusActive, Now: cutoff,
			})
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				cleanup, stop := context.WithTimeout(context.Background(), 2*time.Second)
				defer stop()
				if _, err := pool.Exec(cleanup, "DELETE FROM users WHERE id = $1", owner.ID); err != nil {
					t.Errorf("remove test owner: %v", err)
				}
			}()
			m, err := maps.Create(ctx, domain.CreateMapInput{
				UID: uid, OwnerID: owner.ID, Title: "concurrent retention", Document: []byte(`{}`), Now: cutoff,
			})
			if err != nil {
				t.Fatal(err)
			}
			if err := maps.SoftDelete(ctx, uid, owner.ID, cutoff.Add(-time.Hour)); err != nil {
				t.Fatal(err)
			}

			updater, err := pool.BeginTx(ctx, pgx.TxOptions{})
			if err != nil {
				t.Fatal(err)
			}
			defer updater.Rollback(context.Background())
			updateCtx := domain.WithTxHandle(ctx, updater)
			if _, err := maps.Restore(updateCtx, uid, owner.ID, cutoff); err != nil {
				t.Fatal(err)
			}
			newDeletion := cutoff.Add(time.Hour)
			if redelete {
				if err := maps.SoftDelete(updateCtx, uid, owner.ID, newDeletion); err != nil {
					t.Fatal(err)
				}
			}
			var updaterPID int32
			if err := updater.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&updaterPID); err != nil {
				t.Fatal(err)
			}

			cleaner, err := pool.BeginTx(ctx, pgx.TxOptions{})
			if err != nil {
				t.Fatal(err)
			}
			defer cleaner.Rollback(context.Background())
			var cleanerPID int32
			if err := cleaner.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&cleanerPID); err != nil {
				t.Fatal(err)
			}
			type result struct {
				rows int64
				err  error
			}
			done := make(chan result, 1)
			var worker sync.WaitGroup
			worker.Add(1)
			go func() {
				defer worker.Done()
				rows, err := trash.PurgeExpired(domain.WithTxHandle(ctx, cleaner), cutoff, 1)
				done <- result{rows: rows, err: err}
			}()
			defer func() {
				cancel()
				_ = updater.Rollback(context.Background())
				worker.Wait()
			}()

			// A row lock observation, rather than a guessed delay, guarantees the
			// candidate was selected before Restore/SoftDelete becomes visible.
			ticker := time.NewTicker(10 * time.Millisecond)
			defer ticker.Stop()
			for {
				var blocked bool
				if err := pool.QueryRow(ctx, `SELECT wait_event_type = 'Lock' AND $2::integer = ANY(pg_blocking_pids(pid))
FROM pg_stat_activity WHERE pid = $1`, cleanerPID, updaterPID).Scan(&blocked); err != nil {
					t.Fatalf("observe cleanup row-lock wait: %v", err)
				}
				if blocked {
					break
				}
				select {
				case got := <-done:
					t.Fatalf("cleanup returned before waiting for concurrent update: %+v", got)
				case <-ctx.Done():
					t.Fatal("cleanup did not wait for the concurrent row update")
				case <-ticker.C:
				}
			}
			if err := updater.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case got := <-done:
				if got.err != nil || got.rows != 0 {
					t.Fatalf("concurrent restore/re-delete must survive cleanup: rows=%d error=%v", got.rows, got.err)
				}
			case <-ctx.Done():
				t.Fatal("cleanup did not finish after concurrent update committed")
			}
			if err := cleaner.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			var deletion pgtype.Timestamptz
			if err := pool.QueryRow(ctx, "SELECT deleted_at FROM maps WHERE id = $1", m.ID).Scan(&deletion); err != nil {
				t.Fatalf("updated map must still exist: %v", err)
			}
			if redelete {
				if !deletion.Valid || !deletion.Time.Equal(newDeletion) {
					t.Fatalf("new deletion interval lost: %+v", deletion)
				}
			} else if deletion.Valid {
				t.Fatalf("restored map should be active: %+v", deletion)
			}
		})
	}
}
