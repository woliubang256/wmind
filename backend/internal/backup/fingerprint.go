package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/woliubang256/wmind/backend/internal/backupformat"
)

func decodeValue(raw string) (any, error) {
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.UseNumber() // IDs greater than 2^53 must never be rounded.
	var value any
	if err := dec.Decode(&value); err != nil {
		return nil, err
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		return nil, errors.New("invalid JSON value")
	}
	return value, nil
}

// fingerprintRow removes only documented operational noise. Unknown fields stay.
func fingerprintRow(table string, raw map[string]json.RawMessage) (map[string]any, error) {
	row := make(map[string]any, len(raw))
	for key, value := range raw {
		parsed, err := decodeValue(string(value))
		if err != nil {
			return nil, err
		}
		row[key] = parsed
	}
	switch table {
	case "users":
		delete(row, "last_login_at")
		delete(row, "updated_at")
	case "share_links":
		delete(row, "view_count")
		delete(row, "last_viewed_at")
	case "settings":
		if key, _ := row["key"].(string); strings.HasPrefix(key, "backup.") {
			return nil, nil
		}
		delete(row, "updated_at")
		delete(row, "updated_by")
	case "user_two_factor":
		delete(row, "revision")
	}
	for _, key := range []string{"document", "config", "value", "state"} {
		text, ok := row[key].(string)
		if !ok {
			continue
		}
		value, err := decodeValue(text)
		if err != nil {
			return nil, err
		}
		row[key] = value
	}
	if table == "user_two_factor" {
		state, ok := row["state"].(map[string]any)
		if !ok {
			return nil, errors.New("invalid security state")
		}
		for _, key := range []string{"PendingSecret", "PendingExpiresAt", "LastCounter", "SessionVersion", "Challenges"} {
			delete(state, key)
		}
		if state["Enabled"] == nil {
			state["Enabled"] = false
		}
		if state["Secret"] == nil {
			state["Secret"] = ""
		}
		if state["RecoveryHashes"] == nil {
			state["RecoveryHashes"] = []any{}
		}
		hashes, ok := state["RecoveryHashes"].([]any)
		if len(state) == 3 && state["Enabled"] == false && state["Secret"] == "" && ok && len(hashes) == 0 && len(row) == 2 {
			return nil, nil // Creating an implicit, disabled 2FA row at login is not a change.
		}
	}
	return row, nil
}

// The captured snapshot is immutable; sorting row digests avoids depending on SQL
// row order without retaining entire documents in memory. ZIP bytes remain full.
func contentFingerprint(ctx context.Context, dir string, manifest Manifest) (string, error) {
	hash := sha256.New()
	enc := json.NewEncoder(hash)
	if err := enc.Encode([]any{"wmind-content-v1", manifest.Database, manifest.KeyID}); err != nil {
		return "", err
	}
	for _, table := range backupformat.Tables {
		switch table {
		case "refresh_tokens", "user_tokens", "user_devices", "audit_logs":
			continue
		}
		file, err := os.Open(backupformat.File(dir, table))
		if err != nil {
			return "", err
		}
		var header backupformat.Header
		err = json.NewDecoder(file).Decode(&header)
		err = errors.Join(err, file.Close())
		if err != nil {
			return "", err
		}
		rows := []string{}
		err = backupformat.Read(ctx, dir, table, header.Columns, func(raw map[string]json.RawMessage) error {
			row, err := fingerprintRow(table, raw)
			if err != nil || row == nil {
				return err
			}
			value, err := json.Marshal(row)
			if err != nil {
				return err
			}
			sum := sha256.Sum256(value)
			rows = append(rows, hex.EncodeToString(sum[:]))
			return nil
		})
		if err != nil {
			return "", err
		}
		slices.Sort(rows)
		if err = enc.Encode([]any{table, rows}); err != nil {
			return "", err
		}
	}
	root := filepath.Join(dir, "uploads")
	err := filepath.WalkDir(root, func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		file, err := os.Open(name)
		if err != nil {
			return err
		}
		fileHash := sha256.New()
		size, err := io.Copy(fileHash, file)
		err = errors.Join(err, file.Close(), ctx.Err())
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, name)
		if err != nil {
			return err
		}
		return enc.Encode([]any{filepath.ToSlash(rel), size, hex.EncodeToString(fileHash.Sum(nil))})
	})
	if err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func (m *Manager) unchanged(ctx context.Context, c Configuration, fingerprint string) (backupObject, bool, error) {
	m.mu.RLock()
	var latest backupObject
	for _, object := range m.catalog {
		if object.Target == targetID(c) {
			latest = object
			break
		}
	}
	m.mu.RUnlock()
	if latest.Fingerprint == "" || latest.Fingerprint != fingerprint {
		return latest, false, nil
	}
	exists, err := m.cfg.Remote.Exists(ctx, c, latest.Filename)
	return latest, exists, err
}
