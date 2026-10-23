package backup

import (
	"archive/zip"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/backupformat"
	"github.com/woliubang256/wmind/backend/internal/domain"
)

func archiveFixture(t *testing.T) (string, string, Manifest) {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "database"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, table := range backupformat.Tables {
		if err := os.WriteFile(backupformat.File(dir, table), []byte("{\"columns\":[]}\n"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.MkdirAll(filepath.Join(dir, "uploads"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "uploads", "你好.png"), []byte("image-content"), 0600); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "backup.zip")
	m, err := Pack(t.Context(), dir, out, Manifest{Database: domain.BackupIdentity{Driver: "test", Schema: 3}, CreatedAt: time.Now().UTC(), KeyID: KeyID("secret")})
	if err != nil {
		t.Fatal(err)
	}
	return dir, out, m
}
func TestArchiveRoundTrip(t *testing.T) {
	_, archive, m := archiveFixture(t)
	dest := t.TempDir()
	got, err := Unpack(t.Context(), archive, dest, m.Database, m.KeyID)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Files) != len(backupformat.Tables)+1 {
		t.Fatal(got)
	}
	b, err := os.ReadFile(filepath.Join(dest, "uploads", "你好.png"))
	if err != nil || string(b) != "image-content" {
		t.Fatalf("%q %v", b, err)
	}
	for _, tc := range []struct {
		name string
		id   domain.BackupIdentity
		key  string
	}{{"schema", domain.BackupIdentity{Driver: "test", Schema: 4}, m.KeyID}, {"driver", domain.BackupIdentity{Driver: "other", Schema: 3}, m.KeyID}, {"key", m.Database, "wrong"}} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := Unpack(t.Context(), archive, t.TempDir(), tc.id, tc.key); err == nil {
				t.Fatal("accepted incompatible archive")
			}
		})
	}
}
func TestArchiveRejectsUnsafeAndCorruptMembers(t *testing.T) {
	_, archive, m := archiveFixture(t)
	for _, name := range []string{"../outside", "/tmp/outside", "uploads/../../outside", "uploads\\outside", "uploads/a:stream", "uploads/a//b", "database/unknown.jsonl", "uploads/你好.png", "manifest.json"} {
		t.Run(name, func(t *testing.T) {
			original, err := zip.OpenReader(archive)
			if err != nil {
				t.Fatal(err)
			}
			defer original.Close()
			out := filepath.Join(t.TempDir(), "bad.zip")
			f, _ := os.Create(out)
			zw := zip.NewWriter(f)
			for _, entry := range original.File {
				if err := zw.Copy(entry); err != nil {
					t.Fatal(err)
				}
			}
			w, _ := zw.Create(name)
			_, _ = w.Write([]byte("unsafe"))
			zw.Close()
			f.Close()
			if _, err := Unpack(t.Context(), out, t.TempDir(), m.Database, m.KeyID); err == nil {
				t.Fatal("accepted unsafe/duplicate entry")
			}
		})
	}
	// A valid ZIP CRC with an invalid application checksum must also fail.
	zr, _ := zip.OpenReader(archive)
	defer zr.Close()
	out := filepath.Join(t.TempDir(), "corrupt.zip")
	f, _ := os.Create(out)
	zw := zip.NewWriter(f)
	for _, entry := range zr.File {
		if entry.Name == "manifest.json" {
			for key, member := range m.Files {
				member.SHA256 = strings.Repeat("0", 64)
				m.Files[key] = member
				break
			}
			w, _ := zw.Create(entry.Name)
			json.NewEncoder(w).Encode(m)
		} else {
			zw.Copy(entry)
		}
	}
	zw.Close()
	f.Close()
	if _, err := Unpack(t.Context(), out, t.TempDir(), m.Database, m.KeyID); err == nil {
		t.Fatal("accepted corrupt checksum")
	}
}
func TestCaptureRejectsSymlinksAndSkipsTemporaryUploads(t *testing.T) {
	source := t.TempDir()
	os.WriteFile(filepath.Join(source, ".upload-test"), []byte("partial"), 0600)
	dest := t.TempDir()
	if err := CaptureFiles(context.Background(), source, dest); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dest, ".upload-test")); !os.IsNotExist(err) {
		t.Fatal("captured temporary upload")
	}
	if err := os.Symlink("/etc/passwd", filepath.Join(source, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := CaptureFiles(t.Context(), source, t.TempDir()); err == nil {
		t.Fatal("captured symlink")
	}
}
func TestGateDrainsAndRejects(t *testing.T) {
	var gate Gate
	leave, ok := gate.Enter()
	if !ok {
		t.Fatal("not open")
	}
	ready := make(chan func())
	go func() { ready <- gate.Pause() }()
	deadline := time.After(time.Second)
	for !gate.paused.Load() {
		select {
		case <-deadline:
			t.Fatal("pause not started")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if _, ok := gate.Enter(); ok {
		t.Fatal("allowed a new request")
	}
	select {
	case <-ready:
		t.Fatal("did not drain")
	default:
	}
	leave()
	resume := <-ready
	resume()
	leave, ok = gate.Enter()
	if !ok {
		t.Fatal("not resumed")
	}
	leave()
}

func TestPackRejectsOversizedSourceBeforeReading(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "uploads"), 0700)
	f, err := os.Create(filepath.Join(dir, "uploads", "sparse.bin"))
	if err != nil {
		t.Fatal(err)
	}
	if err = f.Truncate(MaxExtractBytes + 1); err != nil {
		t.Fatal(err)
	}
	f.Close()
	_, err = Pack(t.Context(), dir, filepath.Join(t.TempDir(), "out.zip"), Manifest{})
	if err == nil {
		t.Fatal("created a backup larger than the restore format accepts")
	}
}
