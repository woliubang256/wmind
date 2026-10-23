// Package backup implements administrator-managed backups and upload restoration.
package backup

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/woliubang256/wmind/backend/internal/backupformat"
	"github.com/woliubang256/wmind/backend/internal/domain"
)

const FormatVersion = 1
const MaxZIPBytes int64 = 2 << 30
const MaxExtractBytes int64 = 8 << 30
const maxEntries = 100000

type Member struct {
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}
type Manifest struct {
	Format    int                   `json:"format"`
	Database  domain.BackupIdentity `json:"database"`
	CreatedAt time.Time             `json:"createdAt"`
	KeyID     string                `json:"keyId"`
	Files     map[string]Member     `json:"files"`
}

func KeyID(secret string) string {
	sum := sha256.Sum256([]byte("wmind/backup/key-id/v1\x00" + secret))
	return hex.EncodeToString(sum[:])
}

// CaptureFiles accepts only ordinary files and omits unfinished upload temporaries.
func CaptureFiles(ctx context.Context, source, dest string) error {
	info, err := os.Lstat(source)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return errors.New("uploads must be a real directory")
	}
	if err := os.MkdirAll(dest, 0700); err != nil {
		return err
	}
	return filepath.WalkDir(source, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		rel, err := filepath.Rel(source, p)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		if strings.HasPrefix(d.Name(), ".upload-") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("backup refuses symbolic link: %s", rel)
		}
		target := filepath.Join(dest, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0700)
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("backup refuses special file: %s", rel)
		}
		in, err := os.Open(p)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		_, err = io.Copy(out, in)
		return errors.Join(err, out.Close())
	})
}

func Pack(ctx context.Context, dir, output string, manifest Manifest) (Manifest, error) {
	manifest.Format = FormatVersion
	manifest.Files = make(map[string]Member)
	f, err := os.OpenFile(output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return manifest, err
	}
	zw := zip.NewWriter(f)
	err = filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return errors.New("invalid snapshot file")
		}
		rel, err := filepath.Rel(dir, p)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(rel)
		if !validMember(name) {
			return fmt.Errorf("invalid member %s", name)
		}
		if len(manifest.Files) >= maxEntries {
			return errors.New("too many archive files")
		}
		in, err := os.Open(p)
		if err != nil {
			return err
		}
		defer in.Close()
		writer, err := zw.Create(name)
		if err != nil {
			return err
		}
		hash := sha256.New()
		n, err := io.Copy(io.MultiWriter(writer, hash), in)
		if err != nil {
			return err
		}
		manifest.Files[name] = Member{Size: n, SHA256: hex.EncodeToString(hash.Sum(nil))}
		return nil
	})
	if err == nil {
		var w io.Writer
		w, err = zw.Create("manifest.json")
		if err == nil {
			err = json.NewEncoder(w).Encode(manifest)
		}
	}
	err = errors.Join(err, zw.Close(), f.Close())
	if err != nil {
		_ = os.Remove(output)
	}
	return manifest, err
}

func validMember(name string) bool {
	return name != "" && !strings.ContainsAny(name, "\\\x00:") && !strings.HasPrefix(name, "/") && path.Clean(name) == name && !strings.HasPrefix(name, "../") && name != ".." && (strings.HasPrefix(name, "uploads/") || strings.HasPrefix(name, "database/"))
}

// Unpack validates the complete manifest before materializing bounded members.
// The destination must be a new private staging directory, never live uploads.
func Unpack(ctx context.Context, archive, dest string, identity domain.BackupIdentity, keyID string) (Manifest, error) {
	var manifest Manifest
	st, err := os.Stat(archive)
	if err != nil {
		return manifest, err
	}
	if st.Size() > MaxZIPBytes {
		return manifest, errors.New("ZIP exceeds 2 GiB")
	}
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return manifest, err
	}
	defer zr.Close()
	if len(zr.File) > maxEntries+1 {
		return manifest, errors.New("too many ZIP entries")
	}
	members := make(map[string]*zip.File)
	for _, f := range zr.File {
		if _, ok := members[f.Name]; ok {
			return manifest, errors.New("duplicate ZIP member")
		}
		if !f.Mode().IsRegular() || (f.Name != "manifest.json" && !validMember(f.Name)) {
			return manifest, fmt.Errorf("unsafe ZIP member %q", f.Name)
		}
		members[f.Name] = f
	}
	mf, ok := members["manifest.json"]
	if !ok {
		return manifest, errors.New("missing manifest")
	}
	if mf.UncompressedSize64 > 16<<20 {
		return manifest, errors.New("manifest too large")
	}
	r, err := mf.Open()
	if err != nil {
		return manifest, err
	}
	raw, err := io.ReadAll(io.LimitReader(r, 16<<20+1))
	r.Close()
	if err != nil {
		return manifest, err
	}
	if err = json.Unmarshal(raw, &manifest); err != nil {
		return manifest, err
	}
	if manifest.Format != FormatVersion || manifest.Database != identity {
		return manifest, errors.New("incompatible archive format or database schema")
	}
	if manifest.KeyID != keyID {
		return manifest, errors.New("archive encryption key does not match this server")
	}
	if manifest.CreatedAt.IsZero() || len(manifest.Files)+1 != len(members) {
		return manifest, errors.New("incomplete archive manifest")
	}
	var total int64
	for name, m := range manifest.Files {
		f, ok := members[name]
		if !ok || !validMember(name) || m.Size < 0 || len(m.SHA256) != 64 || f.UncompressedSize64 != uint64(m.Size) {
			return manifest, errors.New("invalid archive member metadata")
		}
		if m.Size > MaxExtractBytes-total {
			return manifest, errors.New("expanded archive exceeds 8 GiB")
		}
		total += m.Size
		if strings.HasPrefix(name, "database/") {
			found := false
			for _, table := range backupformat.Tables {
				if name == "database/"+table+".jsonl" {
					found = true
					break
				}
			}
			if !found {
				return manifest, errors.New("unknown database table")
			}
		}
	}
	for _, table := range backupformat.Tables {
		if _, ok := manifest.Files["database/"+table+".jsonl"]; !ok {
			return manifest, errors.New("missing database table")
		}
	}
	if err = os.MkdirAll(filepath.Join(dest, "uploads"), 0700); err != nil {
		return manifest, err
	}
	for name, m := range manifest.Files {
		if err = ctx.Err(); err != nil {
			return manifest, err
		}
		target := filepath.Join(dest, filepath.FromSlash(name))
		if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return manifest, err
		}
		in, e := members[name].Open()
		if e != nil {
			return manifest, e
		}
		out, e := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			in.Close()
			return manifest, e
		}
		hash := sha256.New()
		n, e := io.Copy(io.MultiWriter(out, hash), io.LimitReader(in, m.Size+1))
		e = errors.Join(e, out.Close(), in.Close())
		if e != nil {
			return manifest, e
		}
		if n != m.Size || hex.EncodeToString(hash.Sum(nil)) != m.SHA256 {
			return manifest, fmt.Errorf("checksum mismatch: %s", name)
		}
	}
	return manifest, nil
}
