package cloud

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"strings"

	"github.com/woliubang256/wmind/backend/internal/service"
)

type imageUpload struct {
	body        []byte
	contentType string
}

type imageDownload struct {
	maxBytes int64
	data     []byte
}

// ImageKey accepts only canonical Wmind attachment and avatar paths.
func ImageKey(path string) (string, bool) {
	key, ok := strings.CutPrefix(path, "/uploads/")
	if !ok {
		return "", false
	}
	_, _, private := service.PrivateFileOwner(key)
	return key, private || service.PublicAvatarKey(key)
}

func (c *Client) UploadImage(ctx context.Context, data []byte) (string, error) {
	if len(data) == 0 || len(data) > service.DefaultMaxFileBytes {
		return "", errors.New("cloud: invalid image size")
	}
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	file, err := form.CreateFormFile("file", "attachment")
	if err != nil {
		return "", err
	}
	if _, err := file.Write(data); err != nil {
		return "", err
	}
	if err := form.Close(); err != nil {
		return "", err
	}
	var result struct{ URL string }
	status, details, err := c.do(ctx, http.MethodPost, "/api/v1/files", imageUpload{body.Bytes(), form.FormDataContentType()}, &result, true)
	if err != nil {
		return "", err
	}
	if status != http.StatusOK && status != http.StatusCreated {
		return "", fmt.Errorf("cloud: image upload failed with HTTP %d (%s)", status, details.Code)
	}
	if _, ok := ImageKey(result.URL); !ok {
		return "", errors.New("cloud: invalid uploaded image address")
	}
	return result.URL, nil
}

func (c *Client) DownloadImage(ctx context.Context, path string) ([]byte, error) {
	if _, ok := ImageKey(path); !ok {
		return nil, errors.New("cloud: invalid image address")
	}
	image := imageDownload{maxBytes: service.DefaultMaxFileBytes}
	status, err := c.readImage(ctx, http.MethodGet, path, &image)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("cloud: image download failed with HTTP %d", status)
	}
	return image.data, nil
}

func (c *Client) HasImage(ctx context.Context, path string) (bool, error) {
	if _, ok := ImageKey(path); !ok {
		return false, nil
	}
	status, err := c.readImage(ctx, http.MethodHead, path, nil)
	if err != nil {
		return false, err
	}
	switch status {
	case http.StatusOK:
		return true, nil
	case http.StatusNotFound:
		return false, nil
	default:
		return false, fmt.Errorf("cloud: image check failed with HTTP %d", status)
	}
}

func (c *Client) readImage(ctx context.Context, method, path string, out any) (int, error) {
	access := c.Session().AccessToken
	status, _, err := c.do(ctx, method, path, nil, out, true)
	if err != nil || status != http.StatusNotFound {
		return status, err
	}
	// Private media also returns 404 for expired credentials. Check the session
	// through an API that distinguishes 401, and retry if the token changed.
	if _, err := c.Me(ctx); err != nil {
		return status, err
	}
	if refreshed := c.Session().AccessToken; refreshed != access {
		status, _, err = c.send(ctx, method, path, nil, out, refreshed)
	}
	return status, err
}
