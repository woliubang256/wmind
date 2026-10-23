// Package backupformat defines the private, versioned application row format.
package backupformat

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"

	"github.com/woliubang256/wmind/backend/internal/domain"
)

// Tables is in foreign-key insertion order. Never trust identifiers from a ZIP.
var Tables = []string{"users", "maps", "templates", "themes", "settings", "refresh_tokens", "user_tokens", "user_devices", "files", "audit_logs", "share_links", "map_revisions", "user_two_factor"}

const MaxRowBytes = 64 << 20

type Header struct {
	Columns []string `json:"columns"`
}

func File(dir, table string) string { return filepath.Join(dir, "database", table+".jsonl") }

func Create(dir, table string, columns []string) (*os.File, *json.Encoder, error) {
	if err := os.MkdirAll(filepath.Join(dir, "database"), 0700); err != nil {
		return nil, nil, err
	}
	f, err := os.OpenFile(File(dir, table), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, nil, err
	}
	enc := json.NewEncoder(f)
	if err = enc.Encode(Header{Columns: columns}); err != nil {
		f.Close()
		return nil, nil, err
	}
	return f, enc, nil
}

// Read validates every column and bounds each row without loading a whole table.
func Read(ctx context.Context, dir, table string, columns []string, consume func(map[string]json.RawMessage) error) error {
	f, err := os.Open(File(dir, table))
	if err != nil {
		return err
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64<<10), MaxRowBytes)
	if !scanner.Scan() {
		return fmt.Errorf("%s: missing header", table)
	}
	var header Header
	if err = json.Unmarshal(scanner.Bytes(), &header); err != nil {
		return err
	}
	if !slices.Equal(header.Columns, columns) {
		return fmt.Errorf("%s: incompatible columns", table)
	}
	for scanner.Scan() {
		if err = ctx.Err(); err != nil {
			return err
		}
		var row map[string]json.RawMessage
		if err = json.Unmarshal(scanner.Bytes(), &row); err != nil {
			return fmt.Errorf("%s: invalid row: %w", table, err)
		}
		if len(row) != len(columns) {
			return fmt.Errorf("%s: invalid row columns", table)
		}
		for _, col := range columns {
			if _, ok := row[col]; !ok {
				return fmt.Errorf("%s: missing column %s", table, col)
			}
		}
		if consume != nil {
			if err = consume(row); err != nil {
				return fmt.Errorf("%s: %w", table, err)
			}
		}
	}
	return scanner.Err()
}

func RevokeState(raw string) (string, error) {
	var state domain.TwoFactorState
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		return "", err
	}
	state.SessionVersion = rand.Text()
	state.PendingSecret = ""
	state.PendingExpiresAt = 0
	state.Challenges = nil
	b, err := json.Marshal(state)
	return string(b), err
}

// Finish coordinates ordinary errors across the DB transaction and file swap.
func Finish(commit func() error, install domain.InstallBackupFiles) error {
	var undo func() error
	if install != nil {
		var err error
		undo, err = install()
		if err != nil {
			return err
		}
	}
	if err := commit(); err != nil {
		if undo != nil {
			return errors.Join(err, undo())
		}
		return err
	}
	return nil
}
