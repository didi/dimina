package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestDesktopDiagnosticsSeparatesWindowsAndDiscardsStaleEvents(t *testing.T) {
	var diagnostics desktopDiagnostics
	if diagnostics.json() != nil {
		t.Fatal("diagnostics should be off by default")
	}
	diagnostics.configure(diagnosticsOptions{Enabled: true, Versions: diagnosticsVersions{Host: "test-host"}})
	generation := diagnostics.generation.Load()
	first := diagnosticEvent{AppID: "demo", WindowID: "first", PagePath: "pages/index?token=SECRET", Phase: "launch-start"}
	diagnostics.record(generation, first)
	second := diagnosticEvent{AppID: "demo", WindowID: "second", Phase: "window-created"}
	diagnostics.record(generation, second)
	finish := diagnostics.beginAPI(diagnosticEvent{AppID: "demo", WindowID: "first", API: "getStorage"})
	finish(context.DeadlineExceeded, false)
	var report struct {
		Versions diagnosticsVersions
		Events   []diagnosticEvent
	}
	if err := json.Unmarshal([]byte(*diagnostics.jsonForWindow("first")), &report); err != nil {
		t.Fatal(err)
	}
	if report.Versions.Host != "test-host" || len(report.Events) != 3 {
		t.Fatalf("unexpected report: %+v", report)
	}
	if report.Events[0].PagePath != "pages/index" || strings.Contains(*diagnostics.json(), "SECRET") {
		t.Fatal("page query was not removed")
	}
	if report.Events[1].CallID == "" || report.Events[1].CallID != report.Events[2].CallID || report.Events[2].Outcome != "timeout" {
		t.Fatalf("API completion did not correlate: %+v", report.Events)
	}
	stale := diagnostics.beginAPI(diagnosticEvent{AppID: "demo", WindowID: "first", API: "readFile"})
	diagnostics.configure(diagnosticsOptions{Enabled: true})
	stale(nil, false)
	diagnostics.record(generation, second)
	if err := json.Unmarshal([]byte(*diagnostics.json()), &report); err != nil || len(report.Events) != 0 {
		t.Fatalf("events leaked across capture generations: %+v", report)
	}
}

func TestDesktopDiagnosticsKeepsLaunchEventsDuringBridgeBursts(t *testing.T) {
	var diagnostics desktopDiagnostics
	diagnostics.configure(diagnosticsOptions{Enabled: true})
	state := &appWindow{id: "one", app: miniProgram{AppID: "demo"}}
	event, ok := rendererDiagnostic(state, rendererLaunchEvent{Phase: "launch-failed", Failure: "app-config", BridgeID: "bridge_1"})
	if !ok || event.AppID != "demo" || event.Failure != "app-config" || event.BridgeID != "bridge_1" {
		t.Fatalf("unexpected renderer event: %+v", event)
	}
	if _, ok := rendererDiagnostic(state, rendererLaunchEvent{Phase: "raw log"}); ok {
		t.Fatal("accepted arbitrary renderer event")
	}
	diagnostics.record(diagnostics.generation.Load(), event)
	for i := 0; i < diagnosticStreamLimit; i++ {
		finish := diagnostics.beginAPI(diagnosticEvent{AppID: "demo", API: "setStorage"})
		finish(nil, false)
	}
	var report struct{ Events []diagnosticEvent }
	if err := json.Unmarshal([]byte(*diagnostics.json()), &report); err != nil || len(report.Events) != 201 || report.Events[0].Phase != "launch-failed" {
		t.Fatalf("Bridge events displaced the launch stream: events=%d, err=%v", len(report.Events), err)
	}
}
