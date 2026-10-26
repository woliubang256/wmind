package uploadgc

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/woliubang256/wmind/backend/internal/backup"
	"github.com/woliubang256/wmind/backend/internal/domain"
)

type references struct {
	rows []domain.UploadReference
	err  error
}

func (r *references) VisitUploadReferences(_ context.Context, visit func(domain.UploadReference) error) error {
	for _, row := range r.rows {
		if err := visit(row); err != nil {
			return err
		}
	}
	return r.err
}

func fixture(t *testing.T) (*Cleaner, *references, *time.Time, string) {
	t.Helper()
	root := t.TempDir()
	refs := &references{}
	now := time.Date(2026, 10, 26, 0, 0, 0, 0, time.UTC)
	gate, err := backup.NewSharedGate(root)
	if err != nil {
		t.Fatal(err)
	}
	c, err := New(Config{Root: root, References: refs, Gate: gate, Now: func() time.Time { return now }})
	if err != nil {
		t.Fatal(err)
	}
	return c, refs, &now, root
}

func put(t *testing.T, root, name string, at time.Time) {
	t.Helper()
	path := filepath.Join(root, name)
	if err := os.WriteFile(path, []byte("image"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, at, at); err != nil {
		t.Fatal(err)
	}
}
func present(t *testing.T, root, name string, want bool) {
	t.Helper()
	_, err := os.Lstat(filepath.Join(root, name))
	if (err == nil) != want {
		t.Fatalf("%s present=%v want=%v err=%v", name, err == nil, want, err)
	}
}
func sweep(t *testing.T, c *Cleaner, want int) {
	t.Helper()
	n, err := c.Sweep(t.Context())
	if err != nil || n != want {
		t.Fatalf("Sweep=%d,%v want=%d", n, err, want)
	}
}
func key(n int) string { return fmt.Sprintf("file_1_%032x.png", n) }

func TestUnusedUploadsRetireAfterObservedGrace(t *testing.T) {
	c, _, now, root := fixture(t)
	old := key(1)
	put(t, root, old, now.Add(-48*time.Hour))
	sweep(t, c, 0)
	*now = now.Add(24*time.Hour - time.Nanosecond)
	sweep(t, c, 0)
	*now = now.Add(time.Nanosecond)
	sweep(t, c, 1)
	present(t, root, old, false)
}

func TestReferencesAcrossDocumentsAvatarsAndSettingsSurvive(t *testing.T) {
	c, refs, now, root := fixture(t)
	avatar := "avatar_01JAAAAAAAAAAAAAAAAAAAAAAA_01JBBBBBBBBBBBBBBBBBBBBBBB.png"
	refs.rows = []domain.UploadReference{
		{URL: "/uploads/" + key(1), Document: []byte(`{"sheets":[{"rootTopic":{"image":{"src":"/uploads/` + key(2) + `"},"children":{"attached":[{"image":{"src":"/uploads/` + key(3) + `"}}],"detached":[{"image":{"src":"/uploads/` + key(4) + `"}}]}},"floatingTopics":[{"image":{"src":"/uploads/` + key(5) + `"}}]}]}`)},
		{URL: "/uploads/" + avatar},
		{Setting: []byte(`{"logo":"https://example.test/uploads/` + key(6) + `?v=1","watermark":["/uploads/` + key(7) + `"]}`)},
		{Document: []byte(`{"sheets":[{"rootTopic":{"image":{"src":"/uploads/` + avatar + `"}}}]}`)},
	}
	for i := 1; i <= 7; i++ {
		put(t, root, key(i), now.Add(-72*time.Hour))
	}
	put(t, root, avatar, now.Add(-72*time.Hour))
	sweep(t, c, 0)
	*now = now.Add(48 * time.Hour)
	sweep(t, c, 0)
	for i := 1; i <= 7; i++ {
		present(t, root, key(i), true)
	}
	present(t, root, avatar, true)
}

func TestReturningReferenceAndReplacementResetRetirement(t *testing.T) {
	c, refs, now, root := fixture(t)
	put(t, root, key(1), now.Add(-72*time.Hour))
	sweep(t, c, 0)
	*now = now.Add(23 * time.Hour)
	refs.rows = []domain.UploadReference{{URL: "/uploads/" + key(1)}}
	sweep(t, c, 0)
	refs.rows = nil
	*now = now.Add(2 * time.Hour)
	sweep(t, c, 0)
	*now = now.Add(23 * time.Hour)
	sweep(t, c, 0)
	put(t, root, key(1), *now)
	*now = now.Add(time.Hour)
	sweep(t, c, 0)
	*now = now.Add(24 * time.Hour)
	sweep(t, c, 1)
}

func TestErrorsUnknownEntriesAndSymlinksNeverDelete(t *testing.T) {
	c, refs, now, root := fixture(t)
	for _, name := range []string{key(1), "unknown.png", ".upload-not-ours"} {
		put(t, root, name, now.Add(-72*time.Hour))
	}
	outside := filepath.Join(t.TempDir(), "outside.png")
	if err := os.WriteFile(outside, []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, key(2))); err != nil {
		t.Fatal(err)
	}
	sweep(t, c, 0)
	*now = now.Add(48 * time.Hour)
	for _, invalid := range []domain.UploadReference{{Document: []byte(`{"broken"`)}, {Setting: []byte(`{`)}} {
		refs.rows = []domain.UploadReference{invalid}
		if _, err := c.Sweep(t.Context()); err == nil {
			t.Fatal("invalid reference snapshot was ignored")
		}
		present(t, root, key(1), true)
	}
	refs.rows = nil
	refs.err = errors.New("database unavailable")
	if _, err := c.Sweep(t.Context()); err == nil {
		t.Fatal("database failure ignored")
	}
	refs.err = nil
	sweep(t, c, 1)
	for _, name := range []string{key(2), "unknown.png", ".upload-not-ours"} {
		present(t, root, name, true)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatal("symlink target was removed")
	}
}

func TestTemporaryFilesAndBatchLimit(t *testing.T) {
	c, _, now, root := fixture(t)
	for i := 1; i <= 102; i++ {
		put(t, root, key(i), now.Add(-72*time.Hour))
	}
	put(t, root, ".upload-123456789", now.Add(-72*time.Hour))
	put(t, root, ".upload-123456788", *now)
	sweep(t, c, 0)
	*now = now.Add(24 * time.Hour)
	sweep(t, c, 100)
	sweep(t, c, 4)
}

func TestSharedGateSkipsInFlightBindingAndBackup(t *testing.T) {
	c, refs, now, root := fixture(t)
	put(t, root, key(1), now.Add(-72*time.Hour))
	sweep(t, c, 0)
	*now = now.Add(48 * time.Hour)
	other, err := backup.NewSharedGate(root)
	if err != nil {
		t.Fatal(err)
	}
	leave, ok := other.Enter()
	if !ok {
		t.Fatal("enter")
	}
	sweep(t, c, 0)
	refs.rows = []domain.UploadReference{{URL: "/uploads/" + key(1)}}
	leave()
	sweep(t, c, 0)
	resume := other.Pause()
	sweep(t, c, 0)
	resume()
	present(t, root, key(1), true)
}

func TestRestartResetsGrace(t *testing.T) {
	c, refs, now, root := fixture(t)
	put(t, root, key(1), now.Add(-72*time.Hour))
	sweep(t, c, 0)
	*now = now.Add(48 * time.Hour)
	restarted, err := New(Config{Root: root, References: refs, Gate: c.cfg.Gate, Now: func() time.Time { return *now }})
	if err != nil {
		t.Fatal(err)
	}
	sweep(t, restarted, 0)
}

func TestDeletionFailureRetriesAndDeletedAvatarIsCollected(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses directory permissions")
	}
	c, _, now, root := fixture(t)
	name := "avatar_01JAAAAAAAAAAAAAAAAAAAAAAA_01JBBBBBBBBBBBBBBBBBBBBBBB.png"
	if !managed(name) {
		t.Fatal("invalid avatar fixture")
	}
	put(t, root, name, now.Add(-72*time.Hour))
	sweep(t, c, 0)
	*now = now.Add(48 * time.Hour)
	if err := os.Chmod(root, 0500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(root, 0700) })
	if n, err := c.Sweep(t.Context()); err == nil || n != 0 {
		t.Fatalf("delete failure = %d,%v", n, err)
	}
	present(t, root, name, true)
	if err := os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	sweep(t, c, 1)
}

func TestRunCancelsAndInvalidConfigurationFails(t *testing.T) {
	if _, err := New(Config{}); err == nil {
		t.Fatal("missing dependencies accepted")
	}
	c, _, _, _ := fixture(t)
	c.cfg.Interval = time.Millisecond
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() { defer close(done); c.Run(ctx) }()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cleaner did not stop")
	}
}

func TestFailedDeletionsDoNotStarveLaterCandidates(t *testing.T) {
	c, _, now, root := fixture(t)
	for i := 1; i <= 101; i++ {
		put(t, root, key(i), now.Add(-72*time.Hour))
	}
	sweep(t, c, 0)
	*now = now.Add(48 * time.Hour)
	c.remove = func(root *os.Root, name string) error {
		if name != key(101) {
			return errors.New("simulated permanent filesystem failure")
		}
		return root.Remove(name)
	}
	if n, err := c.Sweep(t.Context()); n != 0 || err == nil {
		t.Fatalf("first failed batch=%d,%v", n, err)
	}
	if n, err := c.Sweep(t.Context()); n != 1 || err == nil {
		t.Fatalf("later candidate starved=%d,%v", n, err)
	}
	present(t, root, key(101), false)
}
