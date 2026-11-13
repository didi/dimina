package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

type deviceResponse struct {
	ID    string `json:"id"`
	Value any    `json:"value"`
	Error string `json:"error"`
	Code  int    `json:"errCode"`
	Owner string `json:"owner"`
	Event string `json:"event"`
}
type deviceBridge struct {
	mu      sync.Mutex
	writeMu sync.Mutex
	command *exec.Cmd
	stdin   io.WriteCloser
	pending map[string]chan deviceResponse
	owners  map[string]*desktopRuntime
}

var devices = &deviceBridge{pending: map[string]chan deviceResponse{}, owners: map[string]*desktopRuntime{}}

func (b *deviceBridge) start() error {
	if b.command != nil {
		return nil
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	name := "dimina-device-bridge"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	directory := filepath.Dir(executable)
	if runtime.GOOS == "darwin" {
		directory = filepath.Join(directory, "..", "Resources")
	}
	command := exec.Command(filepath.Join(directory, name))
	stdin, err := command.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return err
	}
	command.Stderr = os.Stderr
	if err = command.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return fmt.Errorf("Bluetooth helper could not start: %w", err)
	}
	b.command = command
	b.stdin = stdin
	go func() {
		scanner := bufio.NewScanner(stdout)
		scanner.Buffer(make([]byte, 64<<10), 2<<20)
		for scanner.Scan() {
			var response deviceResponse
			if json.Unmarshal(scanner.Bytes(), &response) != nil {
				continue
			}
			b.mu.Lock()
			pending := b.pending[response.ID]
			owner := b.owners[response.Owner]
			b.mu.Unlock()
			if pending != nil {
				select {
				case pending <- response:
				default:
				}
			} else if owner != nil && response.Event != "" {
				owner.publish(response.Event, "", response.Value)
			}
		}
		_ = command.Wait()
		b.mu.Lock()
		if b.command == command {
			b.command = nil
			b.stdin = nil
			for _, pending := range b.pending {
				select {
				case pending <- deviceResponse{Error: "Bluetooth helper disconnected", Code: 10001}:
				default:
				}
			}
		}
		b.mu.Unlock()
	}()
	return nil
}
func (b *deviceBridge) invoke(parent context.Context, r *desktopRuntime, name string, p map[string]any) (any, error) {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil, errors.New("window is closed")
	}
	b.mu.Lock()
	b.owners[r.owner] = r
	r.mu.Unlock()
	if err := b.start(); err != nil {
		b.mu.Unlock()
		return nil, failure(10001, err.Error())
	}
	if len(b.pending) >= 128 {
		b.mu.Unlock()
		return nil, errors.New("too many pending Bluetooth operations")
	}
	id := secret()
	result := make(chan deviceResponse, 1)
	b.pending[id] = result
	input := b.stdin
	b.mu.Unlock()
	defer func() { b.mu.Lock(); delete(b.pending, id); b.mu.Unlock() }()
	timeout := number(p, "timeout", 10000)
	if timeout < 1 || timeout > 300000 {
		timeout = 10000
	}
	ctx, cancel := context.WithTimeout(parent, time.Duration(timeout+10000)*time.Millisecond)
	defer cancel()
	deadline, _ := ctx.Deadline()
	line, err := json.Marshal(map[string]any{"id": id, "owner": r.owner, "method": name, "params": p, "timeout_ms": max(1, time.Until(deadline).Milliseconds())})
	if err != nil {
		return nil, err
	}
	b.writeMu.Lock()
	_, err = input.Write(append(line, '\n'))
	b.writeMu.Unlock()
	if err != nil {
		return nil, err
	}
	select {
	case response := <-result:
		if response.Error != "" {
			return nil, failure(response.Code, response.Error)
		}
		return response.Value, nil
	case <-ctx.Done():
		b.cancelRequest(input, r.owner, id)
		return nil, failure(10012, ctx.Err().Error())
	case <-r.ctx.Done():
		b.cancelRequest(input, r.owner, id)
		return nil, errors.New("window is closed")
	}
}

// Cancellation is private to the helper protocol and targets one in-flight call.
func (b *deviceBridge) cancelRequest(input io.WriteCloser, owner, id string) {
	line, _ := json.Marshal(map[string]any{"id": secret(), "owner": owner, "method": "__cancelRequest", "params": map[string]any{"requestId": id}})
	go func() { b.writeMu.Lock(); defer b.writeMu.Unlock(); _, _ = input.Write(append(line, '\n')) }()
}
func (b *deviceBridge) closeOwner(owner string) {
	b.mu.Lock()
	delete(b.owners, owner)
	input := b.stdin
	b.mu.Unlock()
	if input == nil {
		return
	}
	line, _ := json.Marshal(map[string]any{"id": secret(), "owner": owner, "method": "__closeOwner"})
	go func() { b.writeMu.Lock(); defer b.writeMu.Unlock(); _, _ = input.Write(append(line, '\n')) }()
}
func (b *deviceBridge) close() {
	b.mu.Lock()
	input := b.stdin
	b.mu.Unlock()
	if input != nil {
		_ = input.Close()
	}
}
