package main

import (
	"bufio"
	"context"
	"crypto/sha256"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/egoist/mygo"
)

// Built by the frontend workspace before Go compilation. No development server
// or external resource directory is required by the resulting executable.
//
//go:embed all:frontend/dist
var frontend embed.FS

type appWindow struct {
	id         string
	app        miniProgram
	window     *mygo.Window
	storage    *appStorage
	storageKey string
	runtime    *desktopRuntime
	openedAt   time.Time
	// Window presentation state is read and changed only on the UI thread.
	presented bool
	closing   bool
	ready     chan struct{}
	readyOnce sync.Once
	readyErr  error
	closed    chan struct{}
}

type Desktop struct {
	sessionNamespace string
	resources        *resourceServer
	openMu           sync.Mutex
	mu               sync.Mutex
	launcher         *mygo.Window
	windows          map[*mygo.Window]*appWindow
	apps             map[string]*appWindow
	scanners         map[*mygo.Window]*scanSession
	scanOwners       map[string]bool
}

var visibility = mygo.NewEvent[bool]("desktop:visible")
var nativeRuntimeEvent = mygo.NewEvent[runtimeEvent]("desktop:event")
var closeRequested = mygo.NewEvent[bool]("desktop:close")

func main() {
	var sdkMode bool
	for _, arg := range os.Args[1:] {
		if arg == "--sdk-host" {
			sdkMode = true
		}
	}
	var sdkData, sdkPackages string
	if sdkMode {
		flags := flag.NewFlagSet("Dimina SDK host", flag.ExitOnError)
		flags.Bool("sdk-host", true, "run as a managed standalone-window container")
		flags.StringVar(&sdkData, "data-dir", "", "host application data directory")
		flags.StringVar(&sdkPackages, "packages-dir", "", "compiled mini-program directory")
		_ = flags.Parse(os.Args[1:])
		if sdkData == "" || sdkPackages == "" {
			log.Fatal("--data-dir and --packages-dir are required in SDK mode")
		}
		var err error
		sdkData, err = filepath.Abs(sdkData)
		if err != nil {
			log.Fatal(err)
		}
		sdkPackages, err = filepath.Abs(sdkPackages)
		if err != nil {
			log.Fatal(err)
		}
		if info, err := os.Stat(sdkPackages); err != nil || !info.IsDir() {
			log.Fatal("invalid packages directory")
		}
	}
	mygo.App.SetName("Dimina Desktop")
	dataDir, err := os.UserConfigDir()
	if err != nil {
		log.Fatal(err)
	}
	dataDir = filepath.Join(dataDir, "dimina-desktop")
	if sdkMode {
		dataDir = sdkData
	}
	if err = os.MkdirAll(dataDir, 0700); err != nil {
		log.Fatal(err)
	}
	logFile, err := os.OpenFile(filepath.Join(dataDir, "desktop.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		log.Fatal(err)
	}
	defer logFile.Close()
	log.SetOutput(io.MultiWriter(os.Stderr, logFile))
	assets, err := fs.Sub(frontend, "frontend/dist")
	if err != nil {
		log.Fatal(err)
	}
	resources, err := startResources(assets, dataDir)
	if err != nil {
		log.Fatal(err)
	}
	defer resources.http.Close()
	defer devices.close()
	resources.packageRoot = sdkPackages
	host := &Desktop{resources: resources, windows: map[*mygo.Window]*appWindow{}, apps: map[string]*appWindow{}}
	if sdkMode {
		sum := sha256.Sum256([]byte(dataDir))
		host.sessionNamespace = hex.EncodeToString(sum[:8]) + "-"
	}
	if sdkMode {
		resources.sdk = newSDKControl(host)
	}
	mygo.Bind(host)
	mygo.App.WhenReady(func() {
		if !sdkMode {
			host.showLauncher()
			return
		}
		_ = resources.sdk.native.write(map[string]any{"protocol": 1, "baseUrl": resources.base + "sdk/control/", "token": resources.sdk.token})
		go func() {
			scanner := bufio.NewScanner(os.Stdin)
			scanner.Buffer(make([]byte, 4096), 2*maxNativePayload)
			for scanner.Scan() {
				var response nativeReply
				if json.Unmarshal(scanner.Bytes(), &response) == nil {
					resources.sdk.native.reply(response)
				}
			}
			resources.sdk.native.shutdown()
			mygo.App.Quit()
		}()
		go func() {
			signals := make(chan os.Signal, 1)
			signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
			<-signals
			mygo.App.Quit()
		}()
	})
	mygo.App.OnActivate(func(hasVisibleWindows bool) {
		if !sdkMode && !hasVisibleWindows {
			host.showLauncher()
		}
	})
	mygo.App.OnWindowAllClosed(func() {
		if !sdkMode && runtime.GOOS != "darwin" {
			mygo.App.Quit()
		}
	})
	if err = mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

func (d *Desktop) pageOptions(session *mygo.Session) mygo.PageOptions {
	tools := mygo.DevToolsDisabled
	if os.Getenv("DIMINA_DESKTOP_DEBUG") == "1" {
		tools = mygo.DevToolsEnabled
	}
	return mygo.PageOptions{TrustedOrigins: []string{d.resources.origin}, Session: session, DevTools: tools}
}

func (d *Desktop) showLauncher() {
	d.mu.Lock()
	if d.launcher != nil {
		win := d.launcher
		d.mu.Unlock()
		win.Show()
		win.Focus()
		return
	}
	d.mu.Unlock()
	win := mygo.NewWindow(mygo.WindowOptions{Title: "星河小程序", URL: d.resources.base, Width: 600, Height: 720, MinWidth: 420, MinHeight: 480, Page: d.pageOptions(nil)})
	d.mu.Lock()
	d.launcher = win
	d.mu.Unlock()
	win.OnClosed(func() {
		d.mu.Lock()
		if d.launcher == win {
			d.launcher = nil
		}
		d.mu.Unlock()
	})
}

func (d *Desktop) caller(ctx context.Context) (*appWindow, bool) {
	win := mygo.CallerWindow(ctx)
	d.mu.Lock()
	defer d.mu.Unlock()
	if win == nil {
		return nil, false
	}
	if win == d.launcher {
		return nil, true
	}
	app, ok := d.windows[win]
	return app, ok
}

func (d *Desktop) ListApps(ctx context.Context) ([]miniProgram, error) {
	if _, ok := d.caller(ctx); !ok {
		return nil, errors.New("unknown window")
	}
	return loadCatalog(d.resources.assets, d.resources.dataDir)
}

func (d *Desktop) ImportApp(ctx context.Context) (miniProgram, error) {
	app, ok := d.caller(ctx)
	if !ok || app != nil {
		return miniProgram{}, errors.New("import is only available in the launcher")
	}
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: mygo.CallerWindow(ctx), Title: "导入小程序", Message: "选择包含 main/app-config.json 的编译产物目录", Directory: true})
	if err != nil {
		return miniProgram{}, err
	}
	if len(paths) == 0 {
		return miniProgram{}, errors.New("已取消导入")
	}
	return importPackage(paths[0], d.resources.dataDir)
}

func (d *Desktop) OpenApp(ctx context.Context, appID string) error {
	if _, ok := d.caller(ctx); !ok {
		return errors.New("unknown window")
	}
	apps, err := loadCatalog(d.resources.assets, d.resources.dataDir)
	if err != nil {
		return err
	}
	var target *miniProgram
	for _, a := range apps {
		if a.AppID == appID {
			copy := a
			target = &copy
			break
		}
	}
	if target == nil {
		return errors.New("小程序不存在")
	}
	_, err = d.openProgram(ctx, *target)
	return err
}

func (d *Desktop) openProgram(ctx context.Context, target miniProgram) (*appWindow, error) {
	openedAt := time.Now()
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		d.openMu.Lock()
		if err := ctx.Err(); err != nil {
			d.openMu.Unlock()
			return nil, err
		}
		d.mu.Lock()
		existing := d.apps[target.AppID]
		d.mu.Unlock()
		if existing != nil {
			var closing bool
			mygo.RunOnMain(func() {
				closing = existing.closing
				if existing.presented && !closing {
					existing.window.Show()
					existing.window.Focus()
				}
			})
			d.openMu.Unlock()
			if !closing {
				return existing, nil
			}
			// The close acknowledgement belongs to the old window. Do not hold
			// either lock or block the UI while waiting to create its replacement.
			select {
			case <-existing.closed:
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		state, err := d.createProgramWindow(target, openedAt)
		d.openMu.Unlock()
		return state, err
	}
}

// The caller holds openMu until the new window has been published in both maps.
func (d *Desktop) createProgramWindow(target miniProgram, openedAt time.Time) (*appWindow, error) {
	appID := target.AppID
	key, storage, err := d.resources.addStorage(appID)
	if err != nil {
		return nil, err
	}
	win := mygo.NewWindow(mygo.WindowOptions{
		Title: target.Name, URL: d.resources.base,
		Width: 460, Height: 780, MinWidth: 340, MinHeight: 400, UseContentSize: true,
		TitleBarStyle: mygo.TitleBarHidden, HideWindowButtons: true,
		Hidden: true, BackgroundColor: "#fff",
		Page: d.pageOptions(mygo.NewSession("miniapp-" + d.sessionNamespace + appID)),
	})
	state := &appWindow{id: secret(), app: target, window: win, storage: storage, storageKey: key, openedAt: openedAt, ready: make(chan struct{}), closed: make(chan struct{})}
	state.runtime = newDesktopRuntime(d.resources, key, appID, func(event runtimeEvent) { _ = nativeRuntimeEvent.Emit(win, event) })
	d.resources.mu.Lock()
	d.resources.runtimes[key] = state.runtime
	d.resources.mu.Unlock()
	log.Printf("[desktop] startup appId=%s stage=window elapsed_ms=%d", appID, time.Since(openedAt).Milliseconds())
	d.mu.Lock()
	d.windows[win] = state
	d.apps[appID] = state
	d.mu.Unlock()
	win.OnMinimize(func() { _ = visibility.Emit(win, false) })
	win.OnHide(func() { _ = visibility.Emit(win, false) })
	win.OnRestore(func() { _ = visibility.Emit(win, true) })
	win.OnShow(func() { _ = visibility.Emit(win, true) })
	win.OnClosed(func() {
		state.beginClosing()
		d.mu.Lock()
		delete(d.windows, win)
		if d.apps[appID] == state {
			delete(d.apps, appID)
		}
		d.mu.Unlock()
		state.runtime.close()
		d.resources.removeStorage(key)
		close(state.closed)
	})
	return state, nil
}

// UI thread only. Cancel startup waiters before asking the renderer to dismiss.
func (w *appWindow) beginClosing() {
	w.closing = true
	w.finishReady(errors.New("window closed before startup completed"))
}

func (w *appWindow) finishReady(err error) {
	w.readyOnce.Do(func() { w.readyErr = err; close(w.ready) })
}

func (d *Desktop) Bootstrap(ctx context.Context) (map[string]any, error) {
	state, ok := d.caller(ctx)
	if !ok {
		return nil, errors.New("unknown window")
	}
	platform := map[string]string{"darwin": "mac", "windows": "windows", "linux": "linux"}[runtime.GOOS]
	result := map[string]any{"baseUrl": d.resources.base, "platform": platform, "system": runtime.GOOS, "arch": runtime.GOARCH}
	if state != nil {
		result["runtimeApis"] = runtimeAPIs
		result["app"] = state.app
		result["resourceBaseUrl"] = d.resources.base + "packages/"
		result["synchronousApiUrl"] = d.resources.base + "sync/" + state.storageKey
		if d.resources.sdk != nil {
			result["nativeApis"] = d.resources.sdk.native.names(state.app.AppID)
		}
	}
	return result, nil
}

func (d *Desktop) RuntimeReady(ctx context.Context) error {
	state, ok := d.caller(ctx)
	if !ok || state == nil {
		return errors.New("unknown app window")
	}
	var err error
	mygo.RunOnMain(func() {
		if state.closing {
			err = errors.New("window is closing")
			state.finishReady(err)
			return
		}
		log.Printf("[desktop] startup appId=%s stage=ready elapsed_ms=%d", state.app.AppID, time.Since(state.openedAt).Milliseconds())
		state.finishReady(nil)
	})
	return err
}

func (d *Desktop) RuntimeFailed(ctx context.Context, message string) error {
	state, ok := d.caller(ctx)
	if !ok || state == nil {
		return errors.New("unknown app window")
	}
	state.finishReady(errors.New(message))
	return nil
}

// PresentWindow is acknowledged only after the frontend has laid out its loading
// UI or startup error. Repeated opens cannot reveal a window before this point.
func (d *Desktop) PresentWindow(ctx context.Context) error {
	state, ok := d.caller(ctx)
	if !ok || state == nil {
		return errors.New("unknown app window")
	}
	mygo.RunOnMain(func() {
		if !state.presented && !state.closing {
			state.presented = true
			state.window.Show()
			state.window.Focus()
			log.Printf("[desktop] startup appId=%s stage=present elapsed_ms=%d", state.app.AppID, time.Since(state.openedAt).Milliseconds())
		}
	})
	return nil
}

// Hide before the container starts removing content, so teardown never exposes
// the empty WebView. Late presentation acknowledgements cannot reopen it.
func (d *Desktop) PrepareToClose(ctx context.Context) error {
	state, ok := d.caller(ctx)
	if !ok || state == nil {
		return errors.New("unknown app window")
	}
	mygo.RunOnMain(func() {
		state.beginClosing()
		state.window.Hide()
	})
	return nil
}

func (d *Desktop) Invoke(ctx context.Context, method string, params json.RawMessage) (any, error) {
	state, ok := d.caller(ctx)
	if !ok || state == nil {
		return nil, errors.New("unknown app window")
	}
	if strings.Contains(method, "Storage") || method == "clearStorage" {
		return state.storage.call(method, params)
	}
	var p map[string]any
	if len(params) > 0 && string(params) != "null" {
		if err := json.Unmarshal(params, &p); err != nil {
			return nil, err
		}
	}
	switch method {
	case "setClipboardData":
		text, ok := p["data"].(string)
		if !ok {
			return nil, errors.New("data must be a string")
		}
		mygo.Clipboard.WriteText(text)
		return map[string]any{}, nil
	case "getClipboardData":
		return map[string]any{"data": mygo.Clipboard.ReadText()}, nil
	case "request":
		requestCtx, cancel := context.WithCancel(ctx)
		stop := context.AfterFunc(state.runtime.ctx, cancel)
		defer cancel()
		defer stop()
		return makeRequest(requestCtx, params)
	case "scanCode":
		return d.scanCode(ctx, state, p)
	case "chooseMessageFile":
		count := 1
		if n, ok := p["count"].(float64); ok && n > 0 {
			count = min(int(n), 100)
		}
		var filters []mygo.FileFilter
		if kind, _ := p["type"].(string); kind == "image" || kind == "video" {
			filters = []mygo.FileFilter{{Name: kind, MIMETypes: []string{kind + "/*"}}}
		} else if extensions, ok := p["extension"].([]any); ok && len(extensions) > 0 {
			filter := mygo.FileFilter{Name: "文件"}
			for _, value := range extensions {
				if ext, ok := value.(string); ok {
					filter.Extensions = append(filter.Extensions, strings.TrimPrefix(ext, "."))
				}
			}
			filters = []mygo.FileFilter{filter}
		}
		paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: state.window, Title: "选择文件", Multiple: count > 1, Filters: filters})
		if err != nil {
			return nil, err
		}
		if len(paths) == 0 {
			return nil, errors.New("cancel")
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		files := make([]map[string]any, 0, min(len(paths), count))
		for _, path := range paths[:min(len(paths), count)] {
			info, err := os.Stat(path)
			if err != nil {
				return nil, err
			}
			if !info.Mode().IsRegular() {
				continue
			}
			key := secret() + "/" + info.Name()
			d.resources.mu.Lock()
			if d.resources.stores[state.storageKey] == nil {
				d.resources.mu.Unlock()
				return nil, errors.New("window is closed")
			}
			d.resources.files[key] = selectedFile{path: path, owner: state.storageKey}
			d.resources.mu.Unlock()
			parts := strings.SplitN(key, "/", 2)
			kind := "file"
			mediaType := mime.TypeByExtension(strings.ToLower(filepath.Ext(info.Name())))
			if strings.HasPrefix(mediaType, "image/") {
				kind = "image"
			} else if strings.HasPrefix(mediaType, "video/") {
				kind = "video"
			}
			files = append(files, map[string]any{"path": d.resources.base + "files/" + parts[0] + "/" + url.PathEscape(parts[1]), "name": info.Name(), "size": info.Size(), "type": kind, "time": info.ModTime().Unix()})
		}
		return map[string]any{"tempFiles": files}, nil
	default:
		value, err := state.runtime.invoke(ctx, method, params)
		var api *apiError
		if errors.As(err, &api) {
			return map[string]any{"errMsg": method + ":fail " + api.message, "errCode": api.code}, nil
		}
		return value, err
	}
}

func makeRequest(ctx context.Context, raw json.RawMessage) (any, error) {
	var p struct {
		URL          string            `json:"url"`
		Method       string            `json:"method"`
		Header       map[string]string `json:"header"`
		Data         json.RawMessage   `json:"data"`
		Timeout      int               `json:"timeout"`
		ResponseType string            `json:"responseType"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, err
	}
	u, err := url.Parse(p.URL)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, errors.New("only http and https URLs are supported")
	}
	if p.Method == "" {
		p.Method = "GET"
	}
	p.Method = strings.ToUpper(p.Method)
	requestHeader := make(http.Header)
	for key, value := range p.Header {
		requestHeader.Set(key, value)
	}
	var data any
	if len(p.Data) > 0 && string(p.Data) != "null" {
		if err := json.Unmarshal(p.Data, &data); err != nil {
			return nil, err
		}
	}
	body := ""
	if p.Method == "GET" || p.Method == "HEAD" {
		if values, ok := data.(map[string]any); ok {
			q := u.Query()
			for k, v := range values {
				q.Set(k, fmt.Sprint(v))
			}
			u.RawQuery = q.Encode()
		}
	} else if text, ok := data.(string); ok {
		body = text
	} else if binary, ok := data.(map[string]any); ok && binary["__diminaArrayBufferBase64"] != nil {
		encoded, ok := binary["__diminaArrayBufferBase64"].(string)
		if !ok {
			return nil, errors.New("invalid binary data")
		}
		decoded, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, err
		}
		body = string(decoded)
	} else if values, ok := data.(map[string]any); ok && strings.Contains(requestHeader.Get("Content-Type"), "application/x-www-form-urlencoded") {
		form := url.Values{}
		for key, value := range values {
			form.Set(key, fmt.Sprint(value))
		}
		body = form.Encode()
	} else if len(p.Data) > 0 {
		body = string(p.Data)
	}
	req, err := http.NewRequestWithContext(ctx, p.Method, u.String(), strings.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header = requestHeader
	if body != "" && req.Header.Get("Content-Type") == "" {
		req.Header.Set("Content-Type", "application/json")
	}
	timeout := 60 * time.Second
	if p.Timeout > 0 {
		timeout = time.Duration(min(p.Timeout, 300000)) * time.Millisecond
	}
	res, err := (&http.Client{Timeout: timeout}).Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	b, err := io.ReadAll(io.LimitReader(res.Body, 32<<20+1))
	if err != nil {
		return nil, err
	}
	if len(b) > 32<<20 {
		return nil, errors.New("response exceeds 32 MiB")
	}
	result := map[string]any{"statusCode": res.StatusCode, "header": res.Header}
	if strings.EqualFold(p.ResponseType, "arraybuffer") {
		result["base64"] = base64.StdEncoding.EncodeToString(b)
	} else {
		result["data"] = strings.ToValidUTF8(string(b), "\uFFFD")
	}
	return result, nil
}
