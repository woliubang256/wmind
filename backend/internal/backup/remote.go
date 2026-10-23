package backup

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type Remote interface {
	Test(context.Context, Configuration) error
	Upload(context.Context, Configuration, string, string) error
}
type RemoteStorage struct{ client *http.Client }

func NewRemoteStorage() *RemoteStorage {
	return &RemoteStorage{client: &http.Client{Timeout: 30 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (r *RemoteStorage) s3Client(c Configuration) *s3.Client {
	return s3.NewFromConfig(aws.Config{Region: c.S3.Region, Credentials: credentials.NewStaticCredentialsProvider(c.S3.AccessKey, c.S3.SecretKey, c.S3.SessionToken), HTTPClient: r.client}, func(o *s3.Options) {
		o.UsePathStyle = c.S3.PathStyle
		if c.S3.Endpoint != "" {
			o.BaseEndpoint = aws.String(c.S3.Endpoint)
		}
	})
}
func s3Key(c Configuration, name string) string { return path.Join(c.S3.Prefix, name) }
func (r *RemoteStorage) dav(ctx context.Context, c Configuration, method, rawURL string, body io.Reader, size int64) (int, error) {
	req, err := http.NewRequestWithContext(ctx, method, rawURL, body)
	if err != nil {
		return 0, errors.New("invalid WebDAV request")
	}
	req.ContentLength = size
	if c.WebDAV.Username != "" || c.WebDAV.Password != "" {
		req.SetBasicAuth(c.WebDAV.Username, c.WebDAV.Password)
	}
	if method == "PROPFIND" {
		req.Header.Set("Depth", "0")
	}
	response, err := r.client.Do(req)
	if err != nil {
		return 0, errors.New("WebDAV connection failed")
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	return response.StatusCode, nil
}
func (r *RemoteStorage) ensureDAV(ctx context.Context, c Configuration, rawURL string, depth int) error {
	if depth > 20 {
		return errors.New("WebDAV path is too deep")
	}
	status, err := r.dav(ctx, c, "PROPFIND", rawURL, nil, 0)
	if err != nil {
		return err
	}
	if status >= 200 && status < 300 {
		return nil
	}
	if status != 404 && status != 409 {
		return fmt.Errorf("WebDAV directory check returned HTTP %d", status)
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return errors.New("invalid WebDAV URL")
	}
	if u.Path == "" || u.Path == "/" {
		return errors.New("WebDAV root not found")
	}
	parent := *u
	parent.Path = path.Dir(strings.TrimRight(u.Path, "/"))
	parent.RawPath = ""
	if err = r.ensureDAV(ctx, c, parent.String(), depth+1); err != nil {
		return err
	}
	status, err = r.dav(ctx, c, "MKCOL", rawURL, nil, 0)
	if err != nil {
		return err
	}
	if status != 201 && status != 405 {
		return fmt.Errorf("WebDAV MKCOL returned HTTP %d", status)
	}
	return nil
}
func (r *RemoteStorage) put(ctx context.Context, c Configuration, name string, body io.ReadSeeker, size int64) error {
	if c.Target == "s3" {
		_, err := r.s3Client(c).PutObject(ctx, &s3.PutObjectInput{Bucket: aws.String(c.S3.Bucket), Key: aws.String(s3Key(c, name)), Body: body, ContentLength: aws.Int64(size), ContentType: aws.String("application/zip")})
		if err != nil {
			return errors.New("S3 upload failed; check endpoint, bucket and write permissions")
		}
		return nil
	}
	if err := r.ensureDAV(ctx, c, c.WebDAV.URL, 0); err != nil {
		return err
	}
	target, err := url.JoinPath(c.WebDAV.URL, name)
	if err != nil {
		return errors.New("invalid WebDAV URL")
	}
	status, err := r.dav(ctx, c, "PUT", target, body, size)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("WebDAV PUT returned HTTP %d", status)
	}
	return nil
}
func (r *RemoteStorage) Upload(ctx context.Context, c Configuration, name, filename string) error {
	if err := c.Validate(true); err != nil {
		return err
	}
	f, err := os.Open(filename)
	if err != nil {
		return err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return err
	}
	return r.put(ctx, c, name, f, stat.Size())
}
func (r *RemoteStorage) Test(ctx context.Context, c Configuration) error {
	if err := c.Validate(true); err != nil {
		return err
	}
	name := ".wmind-connection-test-" + rand.Text() + ".tmp"
	if err := r.put(ctx, c, name, bytes.NewReader([]byte("wmind connection test\n")), 22); err != nil {
		return err
	}
	if c.Target == "s3" {
		_, err := r.s3Client(c).DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(c.S3.Bucket), Key: aws.String(s3Key(c, name))})
		if err != nil {
			return errors.New("S3 test uploaded but cleanup failed; check delete permission")
		}
		return nil
	}
	target, _ := url.JoinPath(c.WebDAV.URL, name)
	status, err := r.dav(ctx, c, "DELETE", target, nil, 0)
	if err != nil {
		return err
	}
	if status < 200 || status >= 300 {
		return fmt.Errorf("WebDAV test cleanup returned HTTP %d", status)
	}
	return nil
}
