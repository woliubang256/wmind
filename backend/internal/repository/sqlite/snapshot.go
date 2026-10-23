package sqlite

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/woliubang256/wmind/backend/internal/backupformat"
	"github.com/woliubang256/wmind/backend/internal/domain"
)

type BackupRepository struct{ db *sql.DB }

func NewBackupRepository(db *sql.DB) *BackupRepository { return &BackupRepository{db: db} }
func (r *BackupRepository) Identity(ctx context.Context) (domain.BackupIdentity, error) {
	id := domain.BackupIdentity{Driver: "sqlite"}
	var dirty bool
	err := r.db.QueryRowContext(ctx, "SELECT version, dirty FROM schema_migrations").Scan(&id.Schema, &dirty)
	if dirty && err == nil {
		err = errors.New("database migration is dirty")
	}
	return id, err
}

type snapshotQuery interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func snapshotColumns(ctx context.Context, q snapshotQuery, table string) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT * FROM "`+table+`" LIMIT 0`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return rows.Columns()
}
func (r *BackupRepository) Export(ctx context.Context, dir string) error {
	tx, err := r.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, table := range backupformat.Tables {
		rows, err := tx.QueryContext(ctx, `SELECT * FROM "`+table+`"`)
		if err != nil {
			return err
		}
		cols, err := rows.Columns()
		if err != nil {
			rows.Close()
			return err
		}
		f, enc, err := backupformat.Create(dir, table, cols)
		if err != nil {
			rows.Close()
			return err
		}
		for rows.Next() {
			values := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range values {
				ptrs[i] = &values[i]
			}
			if err = rows.Scan(ptrs...); err != nil {
				break
			}
			row := make(map[string]any, len(cols))
			for i, c := range cols {
				if b, ok := values[i].([]byte); ok {
					row[c] = string(b)
				} else {
					row[c] = values[i]
				}
			}
			if err = enc.Encode(row); err != nil {
				break
			}
		}
		err = errors.Join(err, rows.Err(), rows.Close(), f.Close())
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (r *BackupRepository) Validate(ctx context.Context, dir string) error {
	for _, table := range backupformat.Tables {
		cols, err := snapshotColumns(ctx, r.db, table)
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
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, table := range slices.Backward(backupformat.Tables) {
		if _, err = tx.ExecContext(ctx, `DELETE FROM "`+table+`"`); err != nil {
			return err
		}
	}
	for _, table := range backupformat.Tables {
		cols, err := snapshotColumns(ctx, tx, table)
		if err != nil {
			return err
		}
		quoted := make([]string, len(cols))
		marks := make([]string, len(cols))
		for i, c := range cols {
			quoted[i] = `"` + c + `"`
			marks[i] = "?"
		}
		stmt, err := tx.PrepareContext(ctx, `INSERT INTO "`+table+`" (`+strings.Join(quoted, ",")+`) VALUES (`+strings.Join(marks, ",")+`)`)
		if err != nil {
			return err
		}
		err = backupformat.Read(ctx, dir, table, cols, func(row map[string]json.RawMessage) error {
			args := make([]any, len(cols))
			for i, c := range cols {
				dec := json.NewDecoder(bytes.NewReader(row[c]))
				dec.UseNumber()
				if e := dec.Decode(&args[i]); e != nil {
					return e
				}
				if n, ok := args[i].(json.Number); ok {
					v, e := n.Int64()
					if e != nil {
						return e
					}
					args[i] = v
				}
			}
			_, e := stmt.ExecContext(ctx, args...)
			return e
		})
		stmt.Close()
		if err != nil {
			return err
		}
	}
	var admins int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM users WHERE role='admin' AND status='active' AND deleted_at IS NULL`).Scan(&admins); err != nil {
		return err
	}
	if admins == 0 {
		return errors.New("backup must contain an active administrator")
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM refresh_tokens"); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM user_tokens"); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT u.id, COALESCE(f.state,'{}') FROM users u LEFT JOIN user_two_factor f ON f.user_id=u.id`)
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
	err = errors.Join(err, rows.Err(), rows.Close())
	if err != nil {
		return err
	}
	for _, v := range factors {
		state, e := backupformat.RevokeState(v.state)
		if e != nil {
			return e
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO user_two_factor(user_id,state,revision) VALUES (?,?,1) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state,revision=user_two_factor.revision+1`, v.id, state); err != nil {
			return err
		}
	}
	if err = backupformat.Finish(tx.Commit, install); err != nil {
		return fmt.Errorf("restore transaction: %w", err)
	}
	return nil
}

var _ domain.BackupRepository = (*BackupRepository)(nil)
