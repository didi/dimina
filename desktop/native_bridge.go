package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const maxNativePayload = 1 << 20

//go:embed mobile_api_names.json
var mobileAPINamesJSON []byte

var mobileAPINames = func() map[string]bool {
	var names []string
	if err := json.Unmarshal(mobileAPINamesJSON, &names); err != nil {
		panic(err)
	}
	result := make(map[string]bool, len(names))
	for _, name := range names {
		result[name] = true
	}
	return result
}()

type nativeRegistration struct {
	Name      string   `json:"name"`
	AppIDs    []string `json:"appIds"`
	TimeoutMS int      `json:"timeoutMs"`
}
type nativeMessage struct {
	Type     string          `json:"type"`
	ID       string          `json:"id"`
	WindowID string          `json:"windowId,omitempty"`
	AppID    string          `json:"appId,omitempty"`
	Name     string          `json:"name,omitempty"`
	Params   json.RawMessage `json:"params,omitempty"`
}
type nativeReply struct {
	Type  string          `json:"type"`
	ID    string          `json:"id"`
	Value json.RawMessage `json:"value"`
	Error string          `json:"error"`
}
type nativeWrite struct {
	ctx                context.Context
	value              any
	result             chan error
	mu                 sync.Mutex
	started, cancelled bool
}
type nativeBridge struct {
	mu         sync.Mutex
	output     io.Writer
	writes     chan *nativeWrite
	wake       chan struct{}
	done       chan struct{}
	writerOnce sync.Once
	cancels    map[string]nativeMessage
	apis       map[string]nativeRegistration
	pending    map[string]chan nativeReply
	closed     bool
}

func newNativeBridge(output io.Writer) *nativeBridge {
	return &nativeBridge{output: output, writes: make(chan *nativeWrite, 128), wake: make(chan struct{}, 1), done: make(chan struct{}), cancels: map[string]nativeMessage{}, apis: map[string]nativeRegistration{}, pending: map[string]chan nativeReply{}}
}
func (b *nativeBridge) write(value any) error {
	_, err := b.writeContext(context.Background(), value)
	return err
}

// One writer bounds memory and goroutines even when a host stops reading stdout.
// Cancel messages have priority over calls which have not reached the host yet.
func (b *nativeBridge) runWriter() {
	encoder := json.NewEncoder(b.output)
	var next *nativeWrite
	for {
		b.mu.Lock()
		if b.closed {
			b.mu.Unlock()
			return
		}
		var cancel nativeMessage
		for id, message := range b.cancels {
			cancel = message
			delete(b.cancels, id)
			break
		}
		if cancel.ID != "" {
			b.mu.Unlock()
			_ = encoder.Encode(cancel)
			continue
		}
		if next != nil {
			next.mu.Lock()
			err := next.ctx.Err()
			if next.cancelled || err != nil {
				next.mu.Unlock()
				b.mu.Unlock()
				next.result <- err
				next = nil
				continue
			}
			// Starting a call and accepting a cancellation are ordered under mu.
			next.started = true
			next.mu.Unlock()
			b.mu.Unlock()
			next.result <- encoder.Encode(next.value)
			next = nil
			continue
		}
		b.mu.Unlock()
		select {
		case <-b.done:
			return
		case <-b.wake:
		case next = <-b.writes:
		}
	}
}

func (b *nativeBridge) writeContext(ctx context.Context, value any) (bool, error) {
	b.writerOnce.Do(func() { go b.runWriter() })
	request := &nativeWrite{ctx: ctx, value: value, result: make(chan error, 1)}
	select {
	case <-ctx.Done():
		return false, ctx.Err()
	case <-b.done:
		return false, errors.New("native bridge is closed")
	case b.writes <- request:
	}
	var err error
	select {
	case err = <-request.result:
	case <-ctx.Done():
		err = ctx.Err()
	case <-b.done:
		err = errors.New("native bridge is closed")
	}
	request.mu.Lock()
	request.cancelled = true
	started := request.started
	if !started {
		request.value = nil
	}
	request.mu.Unlock()
	return started, err
}
func (b *nativeBridge) cancelCall(id string) {
	b.mu.Lock()
	if !b.closed {
		b.cancels[id] = nativeMessage{Type: "native-cancel", ID: id}
	}
	b.mu.Unlock()
	select {
	case b.wake <- struct{}{}:
	default:
	}
}

var nativeNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.]{0,127}$`)

// These mobile APIs use a synchronous or extension protocol, not an async reply.
var mobileSpecialProtocolAPIs = map[string]bool{
	"env": true, "canIUse": true, "getWindowInfo": true, "getAppBaseInfo": true,
	"getDeviceInfo": true, "getSystemSetting": true, "getMenuButtonBoundingClientRect": true,
	"extBridge": true, "extOnBridge": true, "extOffBridge": true,
}

func (b *nativeBridge) register(options nativeRegistration) error {
	if !mobileAPINames[options.Name] {
		return errors.New("API is not in the mobile SDK public API contract")
	}
	if !nativeNamePattern.MatchString(options.Name) || strings.HasSuffix(options.Name, "Sync") || options.Name == "constructor" || options.Name == "prototype" || options.Name == "then" || options.Name == "invokeNative" {
		return errors.New("invalid asynchronous native API name")
	}
	leaf := options.Name[strings.LastIndex(options.Name, ".")+1:]
	if mobileSpecialProtocolAPIs[options.Name] || strings.Contains(options.Name, ".") || strings.HasPrefix(leaf, "on") || strings.HasPrefix(leaf, "off") || (strings.HasPrefix(leaf, "create") && leaf != "createBLEConnection") || strings.HasSuffix(leaf, "Manager") {
		return errors.New("API requires the mobile SDK synchronous, object, event or extension protocol; this adapter supports asynchronous one-shot APIs")
	}
	if options.TimeoutMS == 0 {
		options.TimeoutMS = 30000
	}
	if options.TimeoutMS < 1 || options.TimeoutMS > 300000 {
		return errors.New("timeoutMs must be between 1 and 300000")
	}
	for _, id := range options.AppIDs {
		if !appIDPattern.MatchString(id) {
			return errors.New("invalid appId grant")
		}
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return errors.New("native bridge is closed")
	}
	b.apis[options.Name] = options
	return nil
}
func nativeAllowed(options nativeRegistration, appID string) bool {
	if len(options.AppIDs) == 0 {
		return true
	}
	for _, id := range options.AppIDs {
		if id == appID {
			return true
		}
	}
	return false
}
func (b *nativeBridge) names(appID string) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	result := make([]string, 0, len(b.apis))
	for name, options := range b.apis {
		if nativeAllowed(options, appID) {
			result = append(result, name)
		}
	}
	sort.Strings(result)
	return result
}
func (b *nativeBridge) invoke(ctx context.Context, window *appWindow, name string, params json.RawMessage) (json.RawMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	params = bytes.TrimSpace(params)
	if len(params) > maxNativePayload || !json.Valid(params) || params[0] != '{' {
		return nil, errors.New("native API params must be a JSON object within 1 MiB")
	}
	b.mu.Lock()
	options, exists := b.apis[name]
	if b.closed || !exists || !nativeAllowed(options, window.app.AppID) {
		b.mu.Unlock()
		return nil, errors.New("native API is not registered or not allowed for this app")
	}
	if len(b.pending) >= 128 {
		b.mu.Unlock()
		return nil, errors.New("too many pending native calls")
	}
	id := secret()
	result := make(chan nativeReply, 1)
	b.pending[id] = result
	b.mu.Unlock()
	defer func() { b.mu.Lock(); delete(b.pending, id); b.mu.Unlock() }()
	select {
	case <-window.closed:
		return nil, errors.New("window is closed")
	default:
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(options.TimeoutMS)*time.Millisecond)
	defer cancel()
	writeCtx, stopWrite := context.WithCancel(ctx)
	defer stopWrite()
	go func() {
		select {
		case <-window.closed:
			stopWrite()
		case <-writeCtx.Done():
		}
	}()
	started, writeErr := b.writeContext(writeCtx, nativeMessage{Type: "native-call", ID: id, WindowID: window.id, AppID: window.app.AppID, Name: name, Params: params})
	if writeErr != nil {
		if started {
			b.cancelCall(id)
		}
		return nil, writeErr
	}
	var err error
	select {
	case response := <-result:
		err = ctx.Err()
		select {
		case <-window.closed:
			err = errors.New("window is closed")
		default:
		}
		if err == nil {
			if response.Error != "" {
				return nil, errors.New(response.Error)
			}
			return response.Value, nil
		}
	case <-ctx.Done():
		err = ctx.Err()
	case <-window.closed:
		err = errors.New("window is closed")
	}
	b.cancelCall(id)
	return nil, err
}
func (b *nativeBridge) reply(response nativeReply) {
	if response.Type != "native-result" {
		return
	}
	response.Value = bytes.TrimSpace(response.Value)
	if len(response.Value) == 0 || string(response.Value) == "null" {
		response.Value = json.RawMessage(`{}`)
	}
	if len(response.Value) > maxNativePayload || !json.Valid(response.Value) || response.Value[0] != '{' {
		response.Value = nil
		response.Error = "native API must return a JSON object within 1 MiB"
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if target := b.pending[response.ID]; target != nil {
		select {
		case target <- response:
		default:
		}
	}
}
func (b *nativeBridge) shutdown() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		return
	}
	b.closed = true
	close(b.done)
	for _, target := range b.pending {
		select {
		case target <- nativeReply{Error: "native host disconnected"}:
		default:
		}
	}
}
