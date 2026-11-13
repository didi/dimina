package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"

	"github.com/egoist/mygo"
)

type scanResult struct {
	value map[string]any
	err   error
}
type scanSession struct {
	owner  *appWindow
	params map[string]any
	result chan scanResult
	once   sync.Once
}

func (s *scanSession) finish(value map[string]any, err error) {
	s.once.Do(func() { s.result <- scanResult{value, err} })
}
func (d *Desktop) scanCode(ctx context.Context, owner *appWindow, p map[string]any) (any, error) {
	if types, ok := p["scanType"].([]any); ok {
		for _, kind := range types {
			if kind != "qrCode" && kind != "barCode" && kind != "datamatrix" && kind != "pdf417" {
				return nil, fmt.Errorf("unsupported scanType: %v", kind)
			}
		}
	}
	d.mu.Lock()
	if d.scanners == nil {
		d.scanners = map[*mygo.Window]*scanSession{}
	}
	if d.scanOwners == nil {
		d.scanOwners = map[string]bool{}
	}
	if d.scanOwners[owner.id] {
		d.mu.Unlock()
		return nil, errors.New("scanner is already open")
	}
	d.scanOwners[owner.id] = true
	d.mu.Unlock()
	defer func() { d.mu.Lock(); delete(d.scanOwners, owner.id); d.mu.Unlock() }()

	win := mygo.NewWindow(mygo.WindowOptions{Title: "扫码", URL: d.resources.base + "scan.html", Width: 480, Height: 570, MinWidth: 360, MinHeight: 400, UseContentSize: true, TitleBarStyle: mygo.TitleBarHidden, HideWindowButtons: true, BackgroundColor: "#17191c", Page: d.pageOptions(mygo.NewSession("scanner"))})
	scan := &scanSession{owner: owner, params: p, result: make(chan scanResult, 1)}
	d.mu.Lock()
	d.scanners[win] = scan
	d.mu.Unlock()
	win.OnClosed(func() { scan.finish(nil, errors.New("cancel")); d.mu.Lock(); delete(d.scanners, win); d.mu.Unlock() })
	defer win.Close()
	select {
	case result := <-scan.result:
		return result.value, result.err
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-owner.runtime.ctx.Done():
		return nil, errors.New("cancel")
	}
}
func (d *Desktop) ScanBootstrap(ctx context.Context) (map[string]any, error) {
	d.mu.Lock()
	scan := d.scanners[mygo.CallerWindow(ctx)]
	d.mu.Unlock()
	if scan == nil {
		return nil, errors.New("unknown scanner window")
	}
	return scan.params, nil
}
func (d *Desktop) ScanComplete(ctx context.Context, value json.RawMessage, message string) error {
	d.mu.Lock()
	scan := d.scanners[mygo.CallerWindow(ctx)]
	d.mu.Unlock()
	if scan == nil {
		return errors.New("unknown scanner window")
	}
	if message != "" {
		scan.finish(nil, errors.New(message))
		return nil
	}
	result, err := parseParams(value)
	if err != nil {
		return err
	}
	if text(result, "result") == "" || text(result, "scanType") == "" {
		return errors.New("invalid scan result")
	}
	scan.finish(result, nil)
	return nil
}
