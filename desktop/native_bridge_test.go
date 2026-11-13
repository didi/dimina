package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

type nativeTestOutput struct{ messages chan nativeMessage }

func (o nativeTestOutput) Write(bytes []byte) (int, error) {
	var message nativeMessage
	if err := json.Unmarshal(bytes, &message); err != nil {
		return 0, err
	}
	o.messages <- message
	return len(bytes), nil
}
func nativeTestWindow(id, appID string) *appWindow {
	return &appWindow{id: id, app: miniProgram{AppID: appID}, closed: make(chan struct{})}
}
func nativeNext(t *testing.T, output nativeTestOutput) nativeMessage {
	t.Helper()
	select {
	case message := <-output.messages:
		return message
	case <-time.After(time.Second):
		t.Fatal("native call was not delivered")
		return nativeMessage{}
	}
}

func TestNativeBridgeIdentityGrantsAndResults(t *testing.T) {
	output := nativeTestOutput{make(chan nativeMessage, 8)}
	bridge := newNativeBridge(output)
	if err := bridge.register(nativeRegistration{Name: "getNetworkType", AppIDs: []string{"allowed"}}); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"invokeNative", "getHostVersion", "scanCodeSync", "getDeviceInfo", "onNetworkStatusChange", "extBridge", "../file", "constructor"} {
		if bridge.register(nativeRegistration{Name: name}) == nil {
			t.Fatalf("invalid native name accepted: %s", name)
		}
	}
	if len(bridge.names("denied")) != 0 {
		t.Fatal("API grant leaked")
	}
	deniedContext, cancelDenied := context.WithCancel(context.Background())
	denied := make(chan error, 1)
	go func() {
		_, err := bridge.invoke(deniedContext, nativeTestWindow("other", "denied"), "getNetworkType", json.RawMessage(`{}`))
		denied <- err
	}()
	select {
	case call := <-output.messages:
		cancelDenied()
		<-denied
		t.Fatalf("ungranted app reached native host: %s", call.AppID)
	case err := <-denied:
		cancelDenied()
		if err == nil || !strings.Contains(err.Error(), "not allowed") {
			t.Fatalf("unexpected grant rejection: %v", err)
		}
	case <-time.After(time.Second):
		cancelDenied()
		t.Fatal("native grant check did not finish")
	}
	result := make(chan error, 1)
	go func() {
		value, err := bridge.invoke(context.Background(), nativeTestWindow("real-window", "allowed"), "getNetworkType", json.RawMessage(`{"appId":"forged"}`))
		if err == nil && string(value) != `{"networkType":"wifi"}` {
			err = errors.New("native result was changed")
		}
		result <- err
	}()
	call := nativeNext(t, output)
	if call.Type != "native-call" || call.AppID != "allowed" || call.WindowID != "real-window" {
		t.Fatalf("caller identity was not derived from its window: %+v", call)
	}
	bridge.reply(nativeReply{Type: "native-result", ID: "unrelated", Value: json.RawMessage(`{}`)})
	bridge.reply(nativeReply{Type: "native-result", ID: call.ID, Value: json.RawMessage(`{"networkType":"wifi"}`)})
	if err := <-result; err != nil {
		t.Fatal(err)
	}
}

func TestNativeBridgeCancelsClosedWindowsAndRejectsLateReplies(t *testing.T) {
	output := nativeTestOutput{make(chan nativeMessage, 8)}
	bridge := newNativeBridge(output)
	_ = bridge.register(nativeRegistration{Name: "openSetting"})
	window := nativeTestWindow("one", "demo")
	result := make(chan error, 1)
	go func() {
		_, err := bridge.invoke(context.Background(), window, "openSetting", json.RawMessage(`{}`))
		result <- err
	}()
	call := nativeNext(t, output)
	close(window.closed)
	bridge.reply(nativeReply{Type: "native-result", ID: call.ID, Value: json.RawMessage(`{"late":true}`)})
	if err := <-result; err == nil {
		t.Fatal("closed window still received native success")
	}
	cancel := nativeNext(t, output)
	if cancel.Type != "native-cancel" || cancel.ID != call.ID {
		t.Fatal("host did not receive native cancellation")
	}
	bridge.reply(nativeReply{Type: "native-result", ID: call.ID, Value: json.RawMessage(`{"late":true}`)})
	if len(bridge.pending) != 0 {
		t.Fatal("closed window retained pending native calls")
	}
	ctx, stop := context.WithCancel(context.Background())
	stop()
	if _, err := bridge.invoke(ctx, nativeTestWindow("two", "demo"), "openSetting", json.RawMessage(`{}`)); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled invocation reached native host")
	}
}

func TestNativeBridgeTimeoutErrorAndDisconnect(t *testing.T) {
	output := nativeTestOutput{make(chan nativeMessage, 8)}
	bridge := newNativeBridge(output)
	_ = bridge.register(nativeRegistration{Name: "scanCode", TimeoutMS: 10})
	result := make(chan error, 1)
	go func() {
		_, err := bridge.invoke(context.Background(), nativeTestWindow("one", "demo"), "scanCode", json.RawMessage(`{}`))
		result <- err
	}()
	call := nativeNext(t, output)
	if err := <-result; !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("native timeout lost: %v", err)
	}
	if nativeNext(t, output).ID != call.ID {
		t.Fatal("wrong invocation cancelled")
	}
	_ = bridge.register(nativeRegistration{Name: "scanCode"})
	for _, mode := range []string{"error", "invalid", "disconnect"} {
		go func() {
			_, err := bridge.invoke(context.Background(), nativeTestWindow(mode, "demo"), "scanCode", json.RawMessage(`{}`))
			result <- err
		}()
		call = nativeNext(t, output)
		switch mode {
		case "error":
			bridge.reply(nativeReply{Type: "native-result", ID: call.ID, Error: "user denied"})
		case "invalid":
			bridge.reply(nativeReply{Type: "native-result", ID: call.ID, Value: json.RawMessage(`42`)})
		case "disconnect":
			bridge.shutdown()
		}
		if err := <-result; err == nil {
			t.Fatalf("%s returned success", mode)
		}
	}
}

func TestNativeBridgeClassifiesMobileProtocols(t *testing.T) {
	bridge := newNativeBridge(io.Discard)
	if err := bridge.register(nativeRegistration{Name: "createBLEConnection"}); err != nil {
		t.Errorf("one-shot BLE connection API rejected as a factory: %v", err)
	}
	for _, name := range []string{"TCPSocket.connect", "UDPSocket.send", "FileSystemManager.readFile", "createTCPSocket", "createUDPSocket"} {
		if err := bridge.register(nativeRegistration{Name: name}); err == nil {
			t.Errorf("object protocol API accepted as one-shot: %s", name)
		}
	}
}

func TestNativeBridgeTimeoutIncludesBlockedOutput(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	bridge := newNativeBridge(writer)
	defer bridge.shutdown()
	if err := bridge.register(nativeRegistration{Name: "scanCode", TimeoutMS: 10}); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := bridge.invoke(context.Background(), nativeTestWindow("blocked", "demo"), "scanCode", json.RawMessage(`{}`))
		done <- err
	}()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("unexpected timeout: %v", err)
		}
	case <-time.After(500 * time.Millisecond):
		_ = reader.Close()
		<-done
		t.Fatal("blocked host output bypassed the native API timeout")
	}
}

type nativeWriterFunc func([]byte) (int, error)

func (write nativeWriterFunc) Write(bytes []byte) (int, error) { return write(bytes) }

func TestNativeBridgeSkipsQueuedCallsAfterCancellation(t *testing.T) {
	reader, writer := io.Pipe()
	defer reader.Close()
	defer writer.Close()
	entered := make(chan struct{}, 1)
	bridge := newNativeBridge(nativeWriterFunc(func(bytes []byte) (int, error) {
		select {
		case entered <- struct{}{}:
		default:
		}
		return writer.Write(bytes)
	}))
	defer bridge.shutdown()
	_ = bridge.register(nativeRegistration{Name: "scanCode", TimeoutMS: 30000})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	first := make(chan error, 1)
	go func() {
		_, err := bridge.invoke(ctx, nativeTestWindow("first", "demo"), "scanCode", json.RawMessage(`{}`))
		first <- err
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("first write did not start")
	}
	cancel()
	select {
	case err := <-first:
		if !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("blocked write ignored cancellation")
	}
	_ = bridge.register(nativeRegistration{Name: "scanCode", TimeoutMS: 10})
	if _, err := bridge.invoke(context.Background(), nativeTestWindow("queued", "demo"), "scanCode", json.RawMessage(`{}`)); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("queued call did not time out: %v", err)
	}
	messages := make(chan []nativeMessage, 1)
	go func() {
		scanner := bufio.NewScanner(reader)
		var all []nativeMessage
		for scanner.Scan() {
			var message nativeMessage
			_ = json.Unmarshal(scanner.Bytes(), &message)
			all = append(all, message)
			if message.Type == "barrier" {
				messages <- all
				return
			}
		}
	}()
	if err := bridge.write(nativeMessage{Type: "barrier", ID: "done"}); err != nil {
		t.Fatal(err)
	}
	select {
	case all := <-messages:
		if len(all) != 3 || all[0].Type != "native-call" || all[0].WindowID != "first" || all[1].Type != "native-cancel" || all[1].ID != all[0].ID || all[2].Type != "barrier" {
			t.Fatalf("expired queued call reached the host or cancellation was lost: %+v", all)
		}
	case <-time.After(time.Second):
		t.Fatal("writer did not resume")
	}
}
