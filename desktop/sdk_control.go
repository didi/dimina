package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/egoist/mygo"
)

type sdkWindow struct {
	ID    string `json:"id"`
	AppID string `json:"appId"`
	Name  string `json:"name"`
	Ready bool   `json:"ready"`
}
type sdkOpenOptions struct {
	AppID string `json:"appId"`
	Path  string `json:"path"`
	Name  string `json:"name"`
}
type sdkWindowHost interface {
	sdkOpen(context.Context, sdkOpenOptions) (sdkWindow, error)
	sdkWindows() []sdkWindow
	sdkFocus(string) error
	sdkClose(string) error
	sdkImport(string) (miniProgram, error)
}
type sdkControl struct {
	host  sdkWindowHost
	token string
}

func newSDKControl(host sdkWindowHost) *sdkControl { return &sdkControl{host: host, token: secret()} }

func (s *sdkControl) serve(w http.ResponseWriter, r *http.Request, method string) {
	w.Header().Set("Cache-Control", "no-store")
	expected := "Bearer " + s.token
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte(expected)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if method == "windows" && r.Method == http.MethodGet {
		writeResult(w, s.host.sdkWindows(), nil)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "POST required", http.StatusMethodNotAllowed)
		return
	}
	decode := func(value any) error {
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		decoder.DisallowUnknownFields()
		return decoder.Decode(value)
	}
	var value any
	var err error
	switch method {
	case "open":
		var options sdkOpenOptions
		if err = decode(&options); err == nil {
			if !appIDPattern.MatchString(options.AppID) {
				err = errors.New("invalid appId")
			} else {
				ctx, cancel := context.WithTimeout(r.Context(), 90*time.Second)
				defer cancel()
				value, err = s.host.sdkOpen(ctx, options)
			}
		}
	case "focus", "close":
		var args struct {
			ID string `json:"id"`
		}
		if err = decode(&args); err == nil {
			if args.ID == "" {
				err = errors.New("window id is required")
			} else if method == "focus" {
				err = s.host.sdkFocus(args.ID)
			} else {
				err = s.host.sdkClose(args.ID)
			}
		}
	case "closeAll":
		for _, window := range s.host.sdkWindows() {
			if e := s.host.sdkClose(window.ID); e != nil {
				err = e
				break
			}
		}
	case "import":
		var args struct {
			Path string `json:"path"`
		}
		if err = decode(&args); err == nil {
			if !filepath.IsAbs(args.Path) {
				err = errors.New("package path must be absolute")
			} else {
				value, err = s.host.sdkImport(args.Path)
			}
		}
	default:
		http.NotFound(w, r)
		return
	}
	writeResult(w, value, err)
}

func describeSDKWindow(state *appWindow) sdkWindow {
	info := sdkWindow{ID: state.id, AppID: state.app.AppID, Name: state.app.Name}
	select {
	case <-state.ready:
		info.Ready = state.readyErr == nil
	default:
	}
	return info
}
func (d *Desktop) sdkWindows() []sdkWindow {
	d.mu.Lock()
	defer d.mu.Unlock()
	windows := make([]sdkWindow, 0, len(d.windows))
	for _, state := range d.windows {
		windows = append(windows, describeSDKWindow(state))
	}
	return windows
}
func (d *Desktop) sdkFind(id string) *appWindow {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, state := range d.windows {
		if state.id == id {
			return state
		}
	}
	return nil
}
func (d *Desktop) sdkFocus(id string) error {
	state := d.sdkFind(id)
	if state == nil {
		return errors.New("window is closed")
	}
	mygo.RunOnMain(func() {
		if state.presented && !state.closing {
			state.window.Show()
			state.window.Focus()
		}
	})
	return nil
}
func (d *Desktop) sdkClose(id string) error {
	state := d.sdkFind(id)
	if state == nil {
		return nil
	}
	var err error
	mygo.RunOnMain(func() {
		if state.presented && !state.closing {
			err = closeRequested.Emit(state.window, true)
		} else if !state.closing {
			state.closing = true
			state.window.Hide()
			state.window.Close()
		}
	})
	if err != nil {
		return err
	}
	select {
	case <-state.closed:
		return nil
	case <-time.After(10 * time.Second):
		return errors.New("window did not close")
	}
}
func (d *Desktop) sdkImport(path string) (miniProgram, error) {
	return importPackage(path, d.resources.dataDir)
}
func (d *Desktop) sdkOpen(ctx context.Context, options sdkOpenOptions) (sdkWindow, error) {
	var empty sdkWindow
	if !appIDPattern.MatchString(options.AppID) {
		return empty, errors.New("invalid appId")
	}
	// Imported packages override configured packages, which override bundled demos.
	var source fs.FS
	for _, root := range []string{filepath.Join(d.resources.dataDir, "packages"), d.resources.packageRoot} {
		if root == "" {
			continue
		}
		dir := filepath.Join(root, options.AppID)
		if info, err := os.Stat(dir); err == nil && info.IsDir() {
			source = os.DirFS(dir)
			break
		}
	}
	if source == nil {
		var err error
		source, err = fs.Sub(d.resources.assets, options.AppID)
		if err != nil {
			return empty, err
		}
	}
	entry, err := validatePackage(source)
	if err != nil {
		return empty, err
	}
	if options.Path == "" {
		options.Path = entry
	}
	if strings.TrimSpace(options.Name) == "" {
		options.Name = options.AppID
	}
	state, err := d.openProgram(miniProgram{AppID: options.AppID, Path: options.Path, Name: options.Name})
	if err != nil {
		return empty, err
	}
	select {
	case <-state.ready:
		if state.readyErr != nil {
			return describeSDKWindow(state), state.readyErr
		}
		return describeSDKWindow(state), nil
	case <-ctx.Done():
		return describeSDKWindow(state), ctx.Err()
	}
}
