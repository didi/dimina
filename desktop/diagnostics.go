package main

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type diagnosticsVersions struct {
	Host     string `json:"host,omitempty"`
	SDK      string `json:"sdk,omitempty"`
	JSSDK    string `json:"jssdk,omitempty"`
	Compiler string `json:"compiler,omitempty"`
}

type diagnosticsOptions struct {
	Enabled  bool                `json:"enabled"`
	Versions diagnosticsVersions `json:"versions"`
}

type diagnosticEvent struct {
	Sequence       uint64 `json:"sequence"`
	ElapsedMS      int64  `json:"elapsedMs"`
	Phase          string `json:"phase"`
	AppID          string `json:"appId"`
	PagePath       string `json:"pagePath,omitempty"`
	WindowID       string `json:"windowId,omitempty"`
	BridgeID       string `json:"bridgeId,omitempty"`
	ResourceLoadID string `json:"resourceLoadId,omitempty"`
	Failure        string `json:"failure,omitempty"`
	CallID         string `json:"callId,omitempty"`
	API            string `json:"api,omitempty"`
	Outcome        string `json:"outcome,omitempty"`
}

type desktopDiagnostics struct {
	mu         sync.Mutex
	generation atomic.Uint64
	next       uint64
	sequence   uint64
	started    time.Time
	versions   diagnosticsVersions
	launch     []diagnosticEvent
	bridge     []diagnosticEvent
}

const diagnosticStreamLimit = 200

func (d *desktopDiagnostics) configure(options diagnosticsOptions) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.next++
	d.started, d.versions = time.Now(), options.Versions
	d.launch, d.bridge = nil, nil
	if options.Enabled {
		d.generation.Store(d.next)
	} else {
		d.generation.Store(0)
	}
}

func (d *desktopDiagnostics) record(generation uint64, event diagnosticEvent) {
	if generation != 0 && generation == d.generation.Load() {
		d.mu.Lock()
		defer d.mu.Unlock()
		if generation == d.generation.Load() {
			d.append(event)
		}
	}
}

// append runs under mu. Separate bounds preserve startup records during API bursts.
func (d *desktopDiagnostics) append(event diagnosticEvent) {
	d.sequence++
	event.Sequence = d.sequence
	event.ElapsedMS = time.Since(d.started).Milliseconds()
	if i := strings.IndexAny(event.PagePath, "?#"); i >= 0 {
		event.PagePath = event.PagePath[:i]
	}
	if len(event.PagePath) > 512 || strings.Contains(event.PagePath, "://") {
		event.PagePath = ""
	}
	stream := &d.launch
	if event.CallID != "" {
		stream = &d.bridge
	}
	if len(*stream) == diagnosticStreamLimit {
		copy(*stream, (*stream)[1:])
		(*stream)[len(*stream)-1] = event
	} else {
		*stream = append(*stream, event)
	}
}

func (d *desktopDiagnostics) json() *string {
	return d.jsonForWindow("")
}

func (d *desktopDiagnostics) jsonForWindow(windowID string) *string {
	d.mu.Lock()
	if d.generation.Load() == 0 {
		d.mu.Unlock()
		return nil
	}
	events := slices.Concat(d.launch, d.bridge)
	versions := d.versions
	d.mu.Unlock()
	if windowID != "" {
		events = slices.DeleteFunc(events, func(event diagnosticEvent) bool { return event.WindowID != windowID })
	}
	sort.Slice(events, func(i, j int) bool { return events[i].Sequence < events[j].Sequence })
	if events == nil {
		events = []diagnosticEvent{}
	}
	data, _ := json.Marshal(struct {
		SchemaVersion int                 `json:"schemaVersion"`
		Platform      string              `json:"platform"`
		Versions      diagnosticsVersions `json:"versions"`
		Events        []diagnosticEvent   `json:"events"`
	}{1, "Desktop", versions, events})
	report := string(data)
	return &report
}

func (d *desktopDiagnostics) beginAPI(event diagnosticEvent) func(error, bool) {
	generation := d.generation.Load()
	if generation == 0 || !nativeNamePattern.MatchString(event.API) {
		return nil
	}
	d.mu.Lock()
	if generation != d.generation.Load() {
		d.mu.Unlock()
		return nil
	}
	event.Phase = "api-received"
	event.PagePath = ""
	event.CallID = "call-" + strconv.FormatUint(d.sequence+1, 10)
	d.append(event)
	d.mu.Unlock()

	return func(err error, failedReply bool) {
		event.Phase, event.Outcome = "api-returned", "success"
		if err != nil || failedReply {
			event.Phase, event.Outcome = "api-failed", "fail"
			switch {
			case errors.Is(err, context.Canceled):
				event.Outcome = "cancelled"
			case errors.Is(err, context.DeadlineExceeded):
				event.Outcome = "timeout"
			}
		}
		d.record(generation, event)
	}
}

func windowDiagnostic(state *appWindow, phase string) diagnosticEvent {
	return diagnosticEvent{AppID: state.app.AppID, PagePath: state.app.Path, WindowID: state.id, Phase: phase}
}

type rendererLaunchEvent struct {
	Phase          string `json:"phase"`
	PagePath       string `json:"pagePath"`
	BridgeID       string `json:"bridgeId"`
	ResourceLoadID string `json:"resourceLoadId"`
	Failure        string `json:"failure"`
}

var diagnosticIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)

func rendererDiagnostic(state *appWindow, entry rendererLaunchEvent) (diagnosticEvent, bool) {
	event := windowDiagnostic(state, entry.Phase)
	switch entry.Phase {
	case "launch-start", "worker-created", "config-loaded", "page-frame-ready", "resource-load-start",
		"service-resources-ready", "render-resources-ready", "first-render-sent", "dom-ready", "launch-ready":
	case "launch-failed":
		switch entry.Failure {
		case "worker-start", "app-config", "page-frame", "worker-error", "service-resources-timeout",
			"render-resources", "render-resources-timeout", "first-render-timeout", "restore-page-stack", "page-startup":
			event.Failure = entry.Failure
		}
	default:
		return event, false
	}
	if entry.PagePath != "" {
		event.PagePath = entry.PagePath
	}
	if diagnosticIDPattern.MatchString(entry.BridgeID) {
		event.BridgeID = entry.BridgeID
	}
	if diagnosticIDPattern.MatchString(entry.ResourceLoadID) {
		event.ResourceLoadID = entry.ResourceLoadID
	}
	return event, true
}
