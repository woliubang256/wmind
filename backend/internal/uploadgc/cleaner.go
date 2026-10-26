// Package uploadgc reclaims only known local uploads after an unreferenced
// grace period. It never infers thumbnail purpose from a filename.
package uploadgc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"

	"github.com/woliubang256/wmind/backend/internal/domain"
	"github.com/woliubang256/wmind/backend/internal/service"
)

const GracePeriod = 24 * time.Hour
const BatchSize = 100

type Gate interface{ TryPause() (func(), bool, error) }
type Config struct {
	Root       string
	References domain.UploadReferencesRepo
	Gate       Gate
	Logger     *slog.Logger
	Now        func() time.Time
	Interval   time.Duration
}
type candidate struct {
	since time.Time
	info  os.FileInfo
}
type Cleaner struct {
	cfg        Config
	candidates map[string]candidate
	cursor     string
	remove     func(*os.Root, string) error
}

var temporaryUpload = regexp.MustCompile(`^\.upload-[0-9]{1,10}$`)
var uploadPath = regexp.MustCompile(`/uploads/([^/?#\s"'<>()]+)`)

func New(cfg Config) (*Cleaner, error) {
	if cfg.Root == "" || cfg.References == nil || cfg.Gate == nil {
		return nil, errors.New("upload cleaner requires root, references and shared gate")
	}
	root, err := filepath.EvalSymlinks(cfg.Root)
	if err != nil {
		return nil, err
	}
	cfg.Root, err = filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Interval <= 0 {
		cfg.Interval = time.Hour
	}
	return &Cleaner{cfg: cfg, candidates: make(map[string]candidate)}, nil
}

func managed(key string) bool {
	_, _, valid := service.PrivateFileOwner(key)
	return valid || service.PublicAvatarKey(key) || temporaryUpload.MatchString(key)
}

func addURL(refs map[string]bool, value string) {
	// Preserve references inside notes and future JSON asset fields as well as
	// today's image.src. Conservative retention is safer than deleting a live URL.
	if decoded, err := url.PathUnescape(value); err == nil {
		value = decoded
	}
	for _, match := range uploadPath.FindAllStringSubmatch(value, -1) {
		if managed(match[1]) && !temporaryUpload.MatchString(match[1]) {
			refs[match[1]] = true
		}
	}
}

func addJSON(refs map[string]bool, raw []byte) error {
	if len(raw) == 0 {
		return nil
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return fmt.Errorf("invalid stored upload reference JSON: %w", err)
	}
	var visit func(any)
	visit = func(value any) {
		switch v := value.(type) {
		case string:
			addURL(refs, v)
		case map[string]any:
			for _, item := range v {
				visit(item)
			}
		case []any:
			for _, item := range v {
				visit(item)
			}
		}
	}
	visit(value)
	return nil
}

// Sweep obtains its own exclusive shared-volume gate before reading references.
// Error/partial snapshots never authorize a deletion. Candidate observations are
// process-local deliberately: restarting delays reclamation instead of advancing it.
func (c *Cleaner) Sweep(ctx context.Context) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	resume, ok, err := c.cfg.Gate.TryPause()
	if err != nil || !ok {
		return 0, err
	}
	defer resume()
	refs := make(map[string]bool)
	err = c.cfg.References.VisitUploadReferences(ctx, func(ref domain.UploadReference) error {
		addURL(refs, ref.URL)
		if err := addJSON(refs, ref.Document); err != nil {
			return err
		}
		return addJSON(refs, ref.Setting)
	})
	if err != nil {
		return 0, err
	}
	root, err := os.OpenRoot(c.cfg.Root)
	if err != nil {
		return 0, err
	}
	defer root.Close()
	dir, err := root.Open(".")
	if err != nil {
		return 0, err
	}
	entries, err := dir.ReadDir(-1)
	closeErr := dir.Close()
	if err != nil || closeErr != nil {
		return 0, errors.Join(err, closeErr)
	}
	// Stat every candidate before deleting anything, so a failed directory read
	// cannot make an unseen referenced or changed resource look disposable.
	files := make(map[string]os.FileInfo)
	for _, entry := range entries {
		if !managed(entry.Name()) {
			continue
		}
		info, err := root.Lstat(entry.Name())
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return 0, err
		}
		if info.Mode().IsRegular() {
			files[entry.Name()] = info
		}
	}
	for key := range c.candidates {
		if refs[key] || files[key] == nil {
			delete(c.candidates, key)
		}
	}
	now := c.cfg.Now().UTC()
	for key, info := range files {
		if refs[key] {
			continue
		}
		previous, ok := c.candidates[key]
		if !ok || !sameFile(previous.info, info) || now.Before(previous.since) {
			c.candidates[key] = candidate{since: now, info: info}
		}
	}
	deleted, attempts := 0, 0
	var failures error
	keys := make([]string, 0, len(c.candidates))
	for key := range c.candidates {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	start := sort.Search(len(keys), func(i int) bool { return keys[i] > c.cursor })
	for i := 0; i < len(keys); i++ {
		if err := ctx.Err(); err != nil {
			return deleted, errors.Join(failures, err)
		}
		key := keys[(start+i)%len(keys)]
		p, ok := c.candidates[key]
		if !ok || now.Sub(p.since) < GracePeriod || now.Sub(p.info.ModTime()) < GracePeriod {
			continue
		}
		if attempts >= BatchSize {
			break
		}
		attempts++
		c.cursor = key
		current, err := root.Lstat(key)
		if errors.Is(err, os.ErrNotExist) {
			delete(c.candidates, key)
			continue
		}
		if err != nil {
			failures = errors.Join(failures, err)
			continue
		}
		if !current.Mode().IsRegular() || !sameFile(p.info, current) {
			delete(c.candidates, key)
			continue
		}
		remove := c.remove
		if remove == nil {
			remove = func(root *os.Root, key string) error { return root.Remove(key) }
		}
		if err := remove(root, key); err != nil {
			failures = errors.Join(failures, fmt.Errorf("remove unused upload: %w", err))
			continue
		}
		delete(c.candidates, key)
		deleted++
	}
	return deleted, failures
}

func sameFile(a, b os.FileInfo) bool {
	return os.SameFile(a, b) && a.Size() == b.Size() && a.ModTime().Equal(b.ModTime())
}

func (c *Cleaner) Run(ctx context.Context) {
	for {
		n, err := c.Sweep(ctx)
		if err != nil && ctx.Err() == nil {
			c.cfg.Logger.Error("上传资源回收失败，保留未确认资源", "err", err)
		}
		if n > 0 {
			c.cfg.Logger.Info("上传资源回收完成", "deleted", n)
		}
		delay := c.cfg.Interval
		if n > 0 {
			delay = time.Second
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
