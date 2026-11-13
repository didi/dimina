package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

func testRuntime(t *testing.T) (*desktopRuntime, chan runtimeEvent) {
	t.Helper()
	s, err := startResources(fstest.MapFS{}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	key, _, err := s.addStorage("test")
	if err != nil {
		t.Fatal(err)
	}
	events := make(chan runtimeEvent, 100)
	r := newDesktopRuntime(s, key, "test", func(e runtimeEvent) { events <- e })
	s.runtimes[key] = r
	t.Cleanup(func() { r.close(); s.removeStorage(key); _ = s.http.Close() })
	return r, events
}
func invokeRuntime(t *testing.T, r *desktopRuntime, name string, p any) any {
	t.Helper()
	raw, _ := json.Marshal(p)
	value, err := r.invoke(context.Background(), name, raw)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return value
}
func awaitEvent(t *testing.T, events chan runtimeEvent, id string) any {
	t.Helper()
	select {
	case e := <-events:
		if e.CallbackID != id {
			t.Fatalf("got callback %s, want %s", e.CallbackID, id)
		}
		return e.Value
	case <-time.After(3 * time.Second):
		t.Fatalf("missing callback %s", id)
	}
	return nil
}
func TestUDPBinaryPersistentEventsAndSynchronousBind(t *testing.T) {
	r, events := testRuntime(t)
	for name, id := range map[string]string{"onListening": "listen", "onMessage": "message", "onClose": "close"} {
		invokeRuntime(t, r, "UDPSocket."+name, map[string]any{"socketId": "udp", "callbackId": id})
	}
	url := r.resources.base + "sync/" + r.owner
	response, err := http.Post(url, "application/json", strings.NewReader(`{"name":"UDPSocket.bind","params":{"socketId":"udp","port":0}}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var bound struct{ Value int }
	if err = json.NewDecoder(response.Body).Decode(&bound); err != nil || bound.Value < 1 {
		t.Fatalf("bind must synchronously return its allocated port: %+v %v", bound, err)
	}
	awaitEvent(t, events, "listen")
	conn, err := net.DialUDP("udp", nil, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: bound.Value})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	for range 2 {
		_, _ = conn.Write([]byte{0, 255, 1})
		value := awaitEvent(t, events, "message").(map[string]any)
		bytes, err := messageBytes(value["message"])
		if err != nil || string(bytes) != string([]byte{0, 255, 1}) {
			t.Fatalf("corrupt UDP event: %v", value)
		}
	}
	invokeRuntime(t, r, "UDPSocket.offMessage", map[string]any{"socketId": "udp", "callbackId": "message"})
	_, _ = conn.Write([]byte("ignored"))
	invokeRuntime(t, r, "UDPSocket.close", map[string]any{"socketId": "udp"})
	awaitEvent(t, events, "close")
	raw, _ := json.Marshal(map[string]any{"socketId": "udp"})
	if _, err = r.invoke(context.Background(), "UDPSocket.bind", raw); err == nil {
		t.Fatal("closed socket was resurrected")
	}
	select {
	case event := <-events:
		t.Fatalf("unsubscribed callback fired: %v", event)
	default:
	}
	replacement, err := net.ListenUDP("udp", &net.UDPAddr{Port: bound.Value})
	if err != nil {
		t.Fatalf("closed UDP socket retained its port: %v", err)
	}
	replacement.Close()
}
func TestTCPBinaryAndOwnerClose(t *testing.T) {
	r, events := testRuntime(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		accepted <- conn
		_, _ = io.Copy(conn, conn)
	}()
	for name, id := range map[string]string{"onConnect": "connect", "onMessage": "message"} {
		invokeRuntime(t, r, "TCPSocket."+name, map[string]any{"socketId": "tcp", "callbackId": id})
	}
	invokeRuntime(t, r, "TCPSocket.connect", map[string]any{"socketId": "tcp", "address": "127.0.0.1", "port": listener.Addr().(*net.TCPAddr).Port})
	awaitEvent(t, events, "connect")
	peer := <-accepted
	defer peer.Close()
	invokeRuntime(t, r, "TCPSocket.write", map[string]any{"socketId": "tcp", "data": binary([]byte{0, 255, 1})})
	value := awaitEvent(t, events, "message").(map[string]any)
	data, _ := messageBytes(value["message"])
	if string(data) != string([]byte{0, 255, 1}) {
		t.Fatal("corrupt TCP data")
	}
	r.close()
	peer.SetReadDeadline(time.Now().Add(time.Second))
	if _, err = peer.Read(make([]byte, 1)); !errors.Is(err, io.EOF) {
		t.Fatal("owner close left TCP connection open")
	}
	if err = r.listen("TCPSocket.onMessage", map[string]any{"socketId": "tcp", "callbackId": "late"}); err == nil {
		t.Fatal("closed window accepted a subscription")
	}
}
func TestOwnedDownloadUploadAndCancellation(t *testing.T) {
	r, events := testRuntime(t)
	payload := []byte{0, 255, 1}
	started := make(chan struct{})
	cancelled := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/file":
			w.Write(payload)
		case "/abort":
			close(started)
			<-request.Context().Done()
			close(cancelled)
		default:
			if err := request.ParseMultipartForm(4096); err != nil {
				t.Error(err)
				return
			}
			file, _, err := request.FormFile("file")
			if err != nil {
				t.Error(err)
				return
			}
			defer file.Close()
			data, _ := io.ReadAll(file)
			if string(data) != string(payload) || request.FormValue("field") != "value" {
				t.Error("multipart payload changed")
			}
			w.Header().Set("X-Probe", "ok")
			w.Write([]byte("uploaded"))
		}
	}))
	defer server.Close()
	downloaded := invokeRuntime(t, r, "downloadFile", map[string]any{"url": server.URL + "/file"}).(map[string]any)
	path := downloaded["tempFilePath"].(string)
	value := invokeRuntime(t, r, "uploadFile", map[string]any{"url": server.URL + "/upload", "filePath": path, "name": "file", "formData": map[string]any{"field": "value"}, "progressCallback": "progress", "headersCallback": "headers"}).(map[string]any)
	if value["data"] != "uploaded" {
		t.Fatalf("upload result: %v", value)
	}
	haveHeaders, haveProgress := false, false
	for len(events) > 0 {
		e := <-events
		if e.CallbackID == "headers" {
			haveHeaders = true
		}
		if e.CallbackID == "progress" && e.Value.(map[string]any)["progress"] == 100 {
			haveProgress = true
		}
	}
	if !haveHeaders || !haveProgress {
		t.Fatal("missing transfer events")
	}
	otherKey, _, err := r.resources.addStorage("other")
	if err != nil {
		t.Fatal(err)
	}
	other := newDesktopRuntime(r.resources, otherKey, "other", nil)
	defer other.close()
	defer r.resources.removeStorage(otherKey)
	if _, err := other.filePath(path); err == nil {
		t.Fatal("another mini program accessed the granted file")
	}
	if _, err := r.filePath("/etc/passwd"); err == nil {
		t.Fatal("arbitrary filesystem path accepted")
	}
	done := make(chan error, 1)
	go func() {
		raw, _ := json.Marshal(map[string]any{"url": server.URL + "/abort", "taskId": "abort"})
		_, err := r.invoke(context.Background(), "downloadFile", raw)
		done <- err
	}()
	<-started
	invokeRuntime(t, r, "uploadFileTaskAbort", map[string]any{"taskId": "abort"})
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled transfer succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("abort did not cancel IO")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("server connection not cancelled")
	}
	physical, err := r.filePath(path)
	if err != nil {
		t.Fatal(err)
	}
	r.close()
	if _, err = os.Stat(physical); !os.IsNotExist(err) {
		t.Fatal("window retained temporary file")
	}
}
