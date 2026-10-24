package backup

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/woliubang256/wmind/backend/internal/backupformat"
	"github.com/woliubang256/wmind/backend/internal/domain"
)

func TestFingerprintCanonicalRowsJSONNumbersAndFiles(t *testing.T) {
	dir := t.TempDir()
	for _, table := range backupformat.Tables {
		file, _, err := backupformat.Create(dir, table, []string{})
		if err != nil {
			t.Fatal(err)
		}
		file.Close()
	}
	os.Mkdir(filepath.Join(dir, "uploads"), 0700)
	writeMaps := func(rows ...string) {
		t.Helper()
		file := backupformat.File(dir, "maps")
		data := "{\"columns\":[\"id\",\"document\"]}\n"
		for _, row := range rows {
			data += row + "\n"
		}
		if err := os.WriteFile(file, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	manifest := Manifest{Database: domain.BackupIdentity{Driver: "sqlite", Schema: 1}, KeyID: "test-key"}
	fingerprint := func() string {
		t.Helper()
		hash, err := contentFingerprint(t.Context(), dir, manifest)
		if err != nil {
			t.Fatal(err)
		}
		return hash
	}
	first := `{"id":9007199254740993,"document":"{\"a\":1,\"b\":2}"}`
	second := `{"id":2,"document":"{}"}`
	writeMaps(first, second)
	before := fingerprint()
	writeMaps(second, `{"document":"{ \"b\":2, \"a\":1 }","id":9007199254740993}`)
	if fingerprint() != before {
		t.Fatal("row/key order or JSON whitespace changed version")
	}
	writeMaps(second, `{"document":"{\"a\":1,\"b\":2}","id":9007199254740992}`)
	if fingerprint() == before {
		t.Fatal("large integer precision lost")
	}
	before = fingerprint()
	os.WriteFile(filepath.Join(dir, "uploads", "image.png"), []byte("image"), 0600)
	withFile := fingerprint()
	if withFile == before {
		t.Fatal("new attachment ignored")
	}
	os.WriteFile(filepath.Join(dir, "uploads", "image.png"), []byte("image"), 0600)
	if fingerprint() != withFile {
		t.Fatal("file metadata counted as content")
	}
	os.Rename(filepath.Join(dir, "uploads", "image.png"), filepath.Join(dir, "uploads", "renamed.png"))
	if fingerprint() == withFile {
		t.Fatal("attachment path ignored")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := contentFingerprint(ctx, dir, manifest); err == nil {
		t.Fatal("ignored cancellation")
	}
}

func TestFingerprintSecurityRuntimeAndUnknownFields(t *testing.T) {
	project := func(raw string) string {
		t.Helper()
		var row map[string]json.RawMessage
		if err := json.Unmarshal([]byte(raw), &row); err != nil {
			t.Fatal(err)
		}
		value, err := fingerprintRow("user_two_factor", row)
		if err != nil {
			t.Fatal(err)
		}
		encoded, _ := json.Marshal(value)
		return string(encoded)
	}
	baseline := `{"user_id":1,"revision":1,"state":"{\"Enabled\":true,\"Secret\":\"secret\",\"RecoveryHashes\":[\"a\"]}"}`
	noise := `{"user_id":1,"revision":9,"state":"{\"Enabled\":true,\"Secret\":\"secret\",\"RecoveryHashes\":[\"a\"],\"LastCounter\":5,\"SessionVersion\":\"changed\",\"PendingSecret\":\"pending\",\"Challenges\":[{}]}"}`
	if project(baseline) != project(noise) {
		t.Fatal("2FA login noise changed version")
	}
	for _, state := range []string{`{"Enabled":false,"Secret":"secret","RecoveryHashes":["a"]}`, `{"Enabled":true,"Secret":"new","RecoveryHashes":["a"]}`, `{"Enabled":true,"Secret":"secret","RecoveryHashes":["b"]}`, `{"Enabled":true,"Secret":"secret","RecoveryHashes":["a"],"FutureSecurityFlag":true}`} {
		raw, _ := json.Marshal(map[string]any{"user_id": 1, "revision": 1, "state": state})
		if project(string(raw)) == project(baseline) {
			t.Fatal("real/unknown security change ignored", state)
		}
	}
}
