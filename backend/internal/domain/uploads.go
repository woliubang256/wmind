package domain

import "context"

// UploadReference contains only persisted resource-bearing data, never cached
// settings. A collector must hold the shared storage gate exclusively while
// visiting these rows and deleting files.
type UploadReference struct {
	URL      string
	Document []byte
	Setting  []byte
}

type UploadReferencesRepo interface {
	VisitUploadReferences(context.Context, func(UploadReference) error) error
}
