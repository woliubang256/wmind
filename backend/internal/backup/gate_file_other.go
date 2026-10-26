//go:build !linux && !darwin && !freebsd && !openbsd && !netbsd && !dragonfly

package backup

import "errors"

func sharedFileLock(path string, exclusive bool) (func(), bool, error) {
	if path == "" {
		return func() {}, true, nil
	}
	return nil, false, errors.New("shared maintenance locking is unsupported on this platform")
}
