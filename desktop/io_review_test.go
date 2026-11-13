package main

import (
	"context"
	"encoding/json"
	jsonv2 "encoding/json/v2"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestUploadResponseUsesValidNativeJSON(t *testing.T) {
	r, _ := testRuntime(t)
	path := filepath.Join(t.TempDir(), "upload.bin")
	if err := os.WriteFile(path, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	grant, err := r.grantFile(path)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		io.Copy(io.Discard, req.Body)
		w.Write([]byte{0xff, 0x80, 1})
	}))
	defer server.Close()
	value, err := r.upload(t.Context(), map[string]any{"url": server.URL, "filePath": grant, "name": "file"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = jsonv2.Marshal(value); err != nil {
		t.Fatalf("actual upload success cannot cross MyGo native JSON: %v", err)
	}
}

type capturedDevicePipe struct {
	mu     sync.Mutex
	frames chan map[string]any
}

func (p *capturedDevicePipe) Write(bytes []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	var frame map[string]any
	if err := json.Unmarshal(bytes, &frame); err != nil {
		return 0, err
	}
	p.frames <- frame
	return len(bytes), nil
}
func (p *capturedDevicePipe) Close() error { return nil }
func TestBLECallerCancellationReachesHelper(t *testing.T) {
	r, _ := testRuntime(t)
	input := &capturedDevicePipe{frames: make(chan map[string]any, 4)}
	bridge := deviceBridge{command: &exec.Cmd{}, stdin: input, pending: map[string]chan deviceResponse{}, owners: map[string]*desktopRuntime{}}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { _, err := bridge.invoke(ctx, r, "getBluetoothDevices", map[string]any{}); done <- err }()
	frame := <-input.frames
	cancel()
	if err := <-done; err == nil {
		t.Fatal("cancelled caller succeeded")
	}
	select {
	case control := <-input.frames:
		if control["method"] != "__cancelRequest" || control["params"].(map[string]any)["requestId"] != frame["id"] {
			t.Fatalf("wrong cancellation frame: %v", control)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("caller ended but its native helper request was never cancelled")
	}
}

func TestUploadAbortBeforeRegistrationPreventsNetworkIO(t *testing.T) {
	r, _ := testRuntime(t)
	path := filepath.Join(t.TempDir(), "upload.bin")
	if err := os.WriteFile(path, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	grant, err := r.grantFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var received atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		received.Add(1)
		io.Copy(io.Discard, req.Body)
		w.Write([]byte("accepted"))
	}))
	defer server.Close()
	invokeRuntime(t, r, "uploadFileTaskAbort", map[string]any{"taskId": "upload_pending"})
	_, err = r.upload(t.Context(), map[string]any{"url": server.URL, "filePath": grant, "name": "file", "taskId": "upload_pending"})
	if err == nil || err.Error() != "abort" {
		t.Fatalf("early abort was lost: upload result %v, server received %d uploads", err, received.Load())
	}
	if received.Load() != 0 {
		t.Fatal("cancelled upload reached server")
	}
}

func TestFailedDownloadRemovesPartialFile(t *testing.T) {
	r, _ := testRuntime(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Length", "100")
		w.Write([]byte("partial"))
	}))
	defer server.Close()
	if _, err := r.download(t.Context(), map[string]any{"url": server.URL}); err == nil {
		t.Fatal("truncated download succeeded")
	}
	files, err := os.ReadDir(r.tmpdir)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if len(files) > 0 {
		t.Fatalf("failed download left temporary files: %v", files)
	}
}

func TestUnmatchedTransferAbortsAreBoundedAndExpire(t *testing.T) {
	r, _ := testRuntime(t)
	for i := 0; i < maxEarlyTransferAborts*3; i++ {
		r.abortTask(fmt.Sprintf("unknown_%d", i))
	}
	r.mu.Lock()
	if len(r.earlyAborts) > maxEarlyTransferAborts {
		t.Fatal("unmatched abort records grew without a bound")
	}
	r.earlyAborts["expired"] = time.Now().Add(-time.Second)
	r.mu.Unlock()
	ctx, done, err := r.task(t.Context(), map[string]any{"taskId": "expired"})
	if err != nil {
		t.Fatalf("expired cancellation affected a new transfer: %v", err)
	}
	if err = ctx.Err(); err != nil {
		t.Fatal(err)
	}
	done()
	r.abortTask("early")
	_, _, err = r.task(t.Context(), map[string]any{"taskId": "early"})
	if err == nil {
		t.Fatal("early abort not consumed")
	}
	r.close()
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.earlyAborts) != 0 {
		t.Fatal("closed window retained abort records")
	}
}
