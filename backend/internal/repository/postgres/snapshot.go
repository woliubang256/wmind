package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/woliubang256/wmind/backend/internal/backupformat"
	"github.com/woliubang256/wmind/backend/internal/domain"
)

type BackupRepository struct{ pool *pgxpool.Pool }

func NewBackupRepository(pool *pgxpool.Pool) *BackupRepository { return &BackupRepository{pool: pool} }
func (r *BackupRepository) Identity(ctx context.Context) (domain.BackupIdentity, error) {
	id := domain.BackupIdentity{Driver: "postgres"}
	var dirty bool
	err := r.pool.QueryRow(ctx, "SELECT version, dirty FROM schema_migrations").Scan(&id.Schema, &dirty)
	if dirty && err == nil {
		err = errors.New("database migration is dirty")
	}
	return id, err
}

type snapshotQuery interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func snapshotColumns(ctx context.Context, q snapshotQuery, table string) ([]string, error) {
	rows, err := q.Query(ctx, `SELECT * FROM "`+table+`" LIMIT 0`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols := make([]string, len(rows.FieldDescriptions()))
	for i, f := range rows.FieldDescriptions() {
		cols[i] = f.Name
	}
	return cols, nil
}
func (r *BackupRepository) Export(ctx context.Context, dir string) error {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	for _, table := range backupformat.Tables {
		cols, err := snapshotColumns(ctx, tx, table)
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT row_to_json(t)::text FROM "`+table+`" t`)
		if err != nil {
			return err
		}
		f, enc, err := backupformat.Create(dir, table, cols)
		if err != nil {
			rows.Close()
			return err
		}
		for rows.Next() {
			var raw string
			if err = rows.Scan(&raw); err != nil {
				break
			}
			if err = enc.Encode(json.RawMessage(raw)); err != nil {
				break
			}
		}
		err = errors.Join(err, rows.Err(), f.Close())
		rows.Close()
		if err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}
func (r *BackupRepository) Validate(ctx context.Context, dir string) error {
	for _, table := range backupformat.Tables {
		cols, err := snapshotColumns(ctx, r.pool, table)
		if err != nil {
			return err
		}
		if err = backupformat.Read(ctx, dir, table, cols, nil); err != nil {
			return err
		}
	}
	return nil
}
func (r *BackupRepository) Restore(ctx context.Context, dir string, install domain.InstallBackupFiles) error {
	tx, err := r.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	for _, table := range slices.Backward(backupformat.Tables) {
		if _, err = tx.Exec(ctx, `DELETE FROM "`+table+`"`); err != nil {
			return err
		}
	}
	for _, table := range backupformat.Tables {
		cols, err := snapshotColumns(ctx, tx, table)
		if err != nil {
			return err
		}
		err = backupformat.Read(ctx, dir, table, cols, func(row map[string]json.RawMessage) error {
			raw, e := json.Marshal(row)
			if e != nil {
				return e
			}
			_, e = tx.Exec(ctx, `INSERT INTO "`+table+`" SELECT * FROM json_populate_record(NULL::"`+table+`", $1::json)`, string(raw))
			return e
		})
		if err != nil {
			return err
		}
		if slices.Contains(cols, "id") {
			// Sequences are nontransactional: only advance, never lower on rollback.
			_, err = tx.Exec(ctx, `SELECT setval(pg_get_serial_sequence($1,'id'), GREATEST((SELECT last_value FROM "`+table+`_id_seq"), COALESCE((SELECT max(id) FROM "`+table+`"),1)),true)`, table)
			if err != nil {
				return err
			}
		}
	}
	var admins int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM users WHERE role='admin' AND status='active' AND deleted_at IS NULL`).Scan(&admins); err != nil {
		return err
	}
	if admins == 0 {
		return errors.New("backup must contain an active administrator")
	}
	if _, err = tx.Exec(ctx, "DELETE FROM refresh_tokens"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "DELETE FROM user_tokens"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "DELETE FROM login_challenges"); err != nil {
		return err
	}
	rows, err := tx.Query(ctx, `SELECT u.id, COALESCE(f.state,'{}') FROM users u LEFT JOIN user_two_factor f ON f.user_id=u.id`)
	if err != nil {
		return err
	}
	type factor struct {
		id    int64
		state string
	}
	var factors []factor
	for rows.Next() {
		var v factor
		if err = rows.Scan(&v.id, &v.state); err != nil {
			break
		}
		factors = append(factors, v)
	}
	err = errors.Join(err, rows.Err())
	rows.Close()
	if err != nil {
		return err
	}
	for _, v := range factors {
		state, e := backupformat.RevokeState(v.state)
		if e != nil {
			return e
		}
		if _, err = tx.Exec(ctx, `INSERT INTO user_two_factor(user_id,state,revision) VALUES ($1,$2,1) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state,revision=user_two_factor.revision+1`, v.id, state); err != nil {
			return err
		}
	}
	return backupformat.Finish(func() error { return tx.Commit(ctx) }, install)
}

var _ domain.BackupRepository = (*BackupRepository)(nil)
