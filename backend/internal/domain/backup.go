package domain

import "context"

// BackupIdentity limits application archives to a compatible database schema.
type BackupIdentity struct {
	Driver string `json:"driver"`
	Schema int64  `json:"schema"`
}

// InstallBackupFiles swaps a staged upload directory into place. Undo must be
// callable if the database commit fails. The caller retains the old directory.
type InstallBackupFiles func() (undo func() error, err error)

// BackupRepository owns database-specific consistent snapshots and restoration.
// Restore replaces application rows within a transaction; it never executes SQL
// supplied by the archive. Install is called immediately before commit.
type BackupRepository interface {
	Identity(context.Context) (BackupIdentity, error)
	Export(context.Context, string) error
	Validate(context.Context, string) error
	Restore(context.Context, string, InstallBackupFiles) error
}
