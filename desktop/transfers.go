package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const maxTransferBytes = 256 << 20

func transferRequest(ctx context.Context, p map[string]any, method string, body io.Reader) (*http.Request, error) {
	address, err := url.Parse(text(p, "url"))
	if err != nil || address.Host == "" || (address.Scheme != "http" && address.Scheme != "https") {
		return nil, errors.New("only HTTP(S) URLs are supported")
	}
	request, err := http.NewRequestWithContext(ctx, method, address.String(), body)
	if err != nil {
		return nil, err
	}
	if headers, ok := p["header"].(map[string]any); ok {
		for name, value := range headers {
			request.Header.Set(name, fmt.Sprint(value))
		}
	}
	return request, nil
}

// The WebView dispatches native calls concurrently. An abort can reach the
// runtime before its upload. Retain only a bounded, short-lived cancellation.
const maxEarlyTransferAborts = 128

func (r *desktopRuntime) pruneEarlyAborts(now time.Time) {
	for id, expires := range r.earlyAborts {
		if !expires.After(now) {
			delete(r.earlyAborts, id)
		}
	}
}
func (r *desktopRuntime) abortTask(id string) {
	if id == "" || len(id) > 160 {
		return
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	if cancel := r.tasks[id]; cancel != nil {
		r.mu.Unlock()
		cancel()
		return
	}
	now := time.Now()
	r.pruneEarlyAborts(now)
	if r.earlyAborts == nil {
		r.earlyAborts = map[string]time.Time{}
	}
	if _, exists := r.earlyAborts[id]; !exists && len(r.earlyAborts) >= maxEarlyTransferAborts {
		var oldest string
		var expires time.Time
		for candidate, deadline := range r.earlyAborts {
			if oldest == "" || deadline.Before(expires) {
				oldest = candidate
				expires = deadline
			}
		}
		delete(r.earlyAborts, oldest)
	}
	r.earlyAborts[id] = now.Add(time.Minute)
	r.mu.Unlock()
}
func (r *desktopRuntime) task(parent context.Context, p map[string]any) (context.Context, func(), error) {
	timeout := number(p, "timeout", 60000)
	if timeout < 1 || timeout > 300000 {
		return nil, nil, errors.New("invalid timeout")
	}
	ctx, cancel := context.WithTimeout(parent, time.Duration(timeout)*time.Millisecond)
	stop := context.AfterFunc(r.ctx, cancel)
	id := text(p, "taskId")
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		stop()
		cancel()
		return nil, nil, errors.New("window is closed")
	}
	r.pruneEarlyAborts(time.Now())
	if len(id) > 160 {
		r.mu.Unlock()
		stop()
		cancel()
		return nil, nil, errors.New("invalid taskId")
	}
	if _, aborted := r.earlyAborts[id]; aborted {
		delete(r.earlyAborts, id)
		r.mu.Unlock()
		stop()
		cancel()
		return nil, nil, errors.New("abort")
	}
	if id != "" {
		if _, exists := r.tasks[id]; exists {
			r.mu.Unlock()
			stop()
			cancel()
			return nil, nil, errors.New("duplicate taskId")
		}
		r.tasks[id] = cancel
	}
	r.work.Add(1)
	r.mu.Unlock()
	return ctx, func() {
		defer r.work.Done()
		stop()
		cancel()
		if id != "" {
			r.mu.Lock()
			delete(r.tasks, id)
			r.mu.Unlock()
		}
	}, nil
}
func (r *desktopRuntime) grantFile(path string) (string, error) {
	key := secret() + "/" + filepath.Base(path)
	r.resources.mu.Lock()
	defer r.resources.mu.Unlock()
	if r.resources.stores[r.owner] == nil {
		return "", errors.New("window is closed")
	}
	r.resources.files[key] = selectedFile{path: path, owner: r.owner}
	parts := strings.SplitN(key, "/", 2)
	return r.resources.base + "files/" + parts[0] + "/" + url.PathEscape(parts[1]), nil
}
func (r *desktopRuntime) filePath(value string) (string, error) {
	parsed, err := url.Parse(value)
	if err != nil {
		return "", err
	}
	if parsed.Scheme != "http" || parsed.Host != strings.TrimPrefix(r.resources.origin, "http://") || !strings.HasPrefix(parsed.Path, r.resources.prefix+"files/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("filePath must be a file granted to this mini program")
	}
	key := strings.TrimPrefix(parsed.Path, r.resources.prefix+"files/")
	r.resources.mu.RLock()
	file := r.resources.files[key]
	valid := file.owner == r.owner && r.resources.stores[r.owner] != nil
	r.resources.mu.RUnlock()
	if !valid || file.path == "" {
		return "", errors.New("file permission denied")
	}
	return file.path, nil
}
func (r *desktopRuntime) download(parent context.Context, p map[string]any) (any, error) {
	if text(p, "filePath") != "" {
		return nil, errors.New("downloadFile.filePath requires the native file-system adapter")
	}
	ctx, done, err := r.task(parent, p)
	if err != nil {
		return nil, err
	}
	defer done()
	request, err := transferRequest(ctx, p, "GET", nil)
	if err != nil {
		return nil, err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.ContentLength > maxTransferBytes {
		return nil, errors.New("download exceeds 256 MiB")
	}
	if err = os.MkdirAll(r.tmpdir, 0700); err != nil {
		return nil, err
	}
	file, err := os.CreateTemp(r.tmpdir, "download-*")
	if err != nil {
		return nil, err
	}
	success := false
	defer func() {
		_ = file.Close()
		if !success {
			_ = os.Remove(file.Name())
		}
	}()
	count, err := io.Copy(file, io.LimitReader(response.Body, maxTransferBytes+1))
	if err != nil {
		return nil, err
	}
	if count > maxTransferBytes {
		return nil, errors.New("download exceeds 256 MiB")
	}
	if err = file.Sync(); err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	path, err := r.grantFile(file.Name())
	if err != nil {
		return nil, err
	}
	success = true
	return map[string]any{"tempFilePath": path, "statusCode": response.StatusCode}, nil
}

type progressReader struct {
	source      io.Reader
	sent, total int64
	last        int
	emit        func(any)
}

func (p *progressReader) Read(bytes []byte) (int, error) {
	n, err := p.source.Read(bytes)
	p.sent += int64(n)
	progress := int(p.sent * 100 / p.total)
	if progress != p.last {
		p.last = progress
		p.emit(map[string]any{"progress": progress, "totalBytesSent": p.sent, "totalBytesExpectedToSend": p.total})
	}
	return n, err
}
func (r *desktopRuntime) upload(parent context.Context, p map[string]any) (any, error) {
	for _, option := range []string{"enableHttp2", "enableQuic", "enableProfile"} {
		if boolean(p, option) {
			return nil, fmt.Errorf("%s is not supported", option)
		}
	}
	ctx, done, err := r.task(parent, p)
	if err != nil {
		return nil, err
	}
	defer done()
	path, err := r.filePath(text(p, "filePath"))
	if err != nil {
		return nil, err
	}
	name := text(p, "name")
	if name == "" {
		return nil, errors.New("name is required")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if info.Size() > maxTransferBytes {
		return nil, errors.New("upload exceeds 256 MiB")
	}
	var metadata bytes.Buffer
	form := multipart.NewWriter(&metadata)
	if fields, ok := p["formData"].(map[string]any); ok {
		for key, value := range fields {
			if err = form.WriteField(key, fmt.Sprint(value)); err != nil {
				return nil, err
			}
		}
	}
	if _, err = form.CreateFormFile(name, filepath.Base(path)); err != nil {
		return nil, err
	}
	prefix := append([]byte(nil), metadata.Bytes()...)
	if err = form.Close(); err != nil {
		return nil, err
	}
	suffix := append([]byte(nil), metadata.Bytes()[len(prefix):]...)
	length := int64(len(prefix)+len(suffix)) + info.Size()
	reader := &progressReader{source: io.MultiReader(bytes.NewReader(prefix), file, bytes.NewReader(suffix)), total: length, last: -1, emit: func(value any) { r.callback(text(p, "progressCallback"), value) }}
	request, err := transferRequest(ctx, p, "POST", reader)
	if err != nil {
		return nil, err
	}
	request.ContentLength = length
	request.Header.Set("Content-Type", form.FormDataContentType())
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return nil, errors.New("abort")
		}
		return nil, err
	}
	defer response.Body.Close()
	headers := map[string]string{}
	for key, values := range response.Header {
		headers[key] = strings.Join(values, ", ")
	}
	r.callback(text(p, "headersCallback"), map[string]any{"header": headers})
	data, err := io.ReadAll(io.LimitReader(response.Body, 32<<20+1))
	if err != nil {
		return nil, err
	}
	if len(data) > 32<<20 {
		return nil, errors.New("upload response exceeds 32 MiB")
	}
	return map[string]any{"data": strings.ToValidUTF8(string(data), "\uFFFD"), "statusCode": response.StatusCode}, nil
}
