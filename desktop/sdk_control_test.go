package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeSDKHost struct {
	calls  []string
	opened sdkOpenOptions
}

func (f *fakeSDKHost) sdkOpen(ctx context.Context, o sdkOpenOptions) (sdkWindow, error) {
	f.calls = append(f.calls, "open")
	f.opened = o
	if o.AppID == "broken" {
		return sdkWindow{}, errors.New("startup failed")
	}
	return sdkWindow{ID: "window-1", AppID: o.AppID, Name: o.Name, Ready: true}, ctx.Err()
}
func (f *fakeSDKHost) sdkWindows() []sdkWindow {
	return []sdkWindow{{ID: "window-1", AppID: "demo", Ready: true}}
}
func (f *fakeSDKHost) sdkFocus(id string) error { f.calls = append(f.calls, "focus:"+id); return nil }
func (f *fakeSDKHost) sdkClose(id string) error { f.calls = append(f.calls, "close:"+id); return nil }
func (f *fakeSDKHost) sdkImport(path string) (miniProgram, error) {
	f.calls = append(f.calls, "import")
	return miniProgram{AppID: "imported", Name: path}, nil
}

func TestSDKControlAuthenticationAndTypedOperations(t *testing.T) {
	host := &fakeSDKHost{}
	sdk := newSDKControl(host)
	request := func(method, path, body, auth string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, "http://127.0.0.1/sdk/control/"+path, strings.NewReader(body))
		req.Header.Set("Authorization", auth)
		res := httptest.NewRecorder()
		sdk.serve(res, req, path)
		return res
	}
	if res := request("POST", "open", `{"appId":"demo"}`, ""); res.Code != 401 {
		t.Fatalf("untrusted controller: %d", res.Code)
	}
	if len(host.calls) != 0 {
		t.Fatal("unauthenticated request reached host")
	}
	auth := "Bearer " + sdk.token
	for _, body := range []string{`{"appId":"../other"}`, `{"appId":"demo","unknown":true}`} {
		if res := request("POST", "open", body, auth); res.Code != 400 {
			t.Fatalf("invalid request accepted: %s", body)
		}
	}
	if len(host.calls) != 0 {
		t.Fatal("invalid request reached host")
	}
	res := request("POST", "open", `{"appId":"demo","path":"pages/index","name":"Demo"}`, auth)
	if res.Code != 200 || !strings.Contains(res.Body.String(), `"ready":true`) {
		t.Fatalf("open failed: %s", res.Body.String())
	}
	if host.opened.Path != "pages/index" {
		t.Fatal("entry path was not forwarded")
	}
	if res.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("control response was cacheable")
	}
	if res := request("POST", "open", `{"appId":"broken"}`, auth); res.Code != 400 || !strings.Contains(res.Body.String(), "startup failed") {
		t.Fatal("startup failure not propagated")
	}
	for _, op := range []string{"focus", "close"} {
		if res := request("POST", op, `{"id":"window-1"}`, auth); res.Code != 200 {
			t.Fatal(res.Body.String())
		}
	}
	res = request("GET", "windows", "", auth)
	var result struct {
		Value []sdkWindow `json:"value"`
	}
	if json.Unmarshal(res.Body.Bytes(), &result) != nil || len(result.Value) != 1 {
		t.Fatal("window list invalid")
	}
	if res := request(http.MethodPost, "import", `{"path":"relative"}`, auth); res.Code != 400 {
		t.Fatal("relative package path accepted")
	}
	if res := request(http.MethodGet, "close", "", auth); res.Code != 405 {
		t.Fatal("unsafe HTTP method accepted")
	}
}

func TestSDKReadinessCannotBeOverwrittenByLaterClose(t *testing.T) {
	state := &appWindow{id: "one", app: miniProgram{AppID: "demo"}, ready: make(chan struct{})}
	if describeSDKWindow(state).Ready {
		t.Fatal("window reported ready before first DOM")
	}
	state.finishReady(nil)
	state.finishReady(errors.New("closed"))
	if !describeSDKWindow(state).Ready {
		t.Fatal("late close overwrote successful startup")
	}
	failed := &appWindow{ready: make(chan struct{})}
	failed.finishReady(errors.New("startup failed"))
	failed.finishReady(nil)
	if describeSDKWindow(failed).Ready {
		t.Fatal("late ready overwrote failed startup")
	}
}
