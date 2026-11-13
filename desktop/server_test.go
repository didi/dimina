package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestOnlyVersionedRuntimeAssetsAreImmutable(t *testing.T) {
	s, err := startResources(fstest.MapFS{
		"index.html":             {Data: []byte("shell")},
		"assets/index-ABC123.js": {Data: []byte("runtime")},
	}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.http.Close()
	for _, path := range []string{"assets/index-ABC123.js", "index.html", "assets/missing.js"} {
		req := httptest.NewRequest("GET", s.base+path, nil)
		res := httptest.NewRecorder()
		s.ServeHTTP(res, req)
		if path == "assets/index-ABC123.js" {
			if res.Header().Get("Cache-Control") != "private, max-age=31536000, immutable" {
				t.Fatalf("runtime asset cannot be reused: %q", res.Header().Get("Cache-Control"))
			}
		} else if strings.Contains(res.Header().Get("Cache-Control"), "immutable") {
			t.Fatalf("unversioned or missing resource cached as immutable: %s", path)
		}
	}
}

func TestPrivateResourcesAndSyncStorage(t *testing.T) {
	assets := fstest.MapFS{"index.html": {Data: []byte("shell")}, "sample/main/logic.js": {Data: []byte("logic")}}
	s, err := startResources(assets, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.http.Close()
	key, _, err := s.addStorage("sample")
	if err != nil {
		t.Fatal(err)
	}
	for _, url := range []string{s.origin + "/index.html", s.base + "../index.html"} {
		res, err := http.Get(url)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode == 200 {
			t.Fatal("unguarded URL served content")
		}
	}
	req, _ := http.NewRequest("POST", s.base+"sync/"+key, strings.NewReader(`{"name":"setStorageSync","params":["k",42]}`))
	req.Header.Set("Origin", "https://unrelated.example")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatalf("cross-origin write: %d", res.StatusCode)
	}
	res, err = http.Post(s.base+"sync/"+key, "application/json", strings.NewReader(`{"name":"setStorageSync","params":["k",42]}`))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal(res.Status)
	}
	res, err = http.Post(s.base+"sync/"+key, "application/json", strings.NewReader(`{"name":"getStorageSync","params":{"key":"k"}}`))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(res.Body)
	res.Body.Close()
	if string(b) != "{\"value\":42}\n" {
		t.Fatalf("unexpected result %s", b)
	}
	s.removeStorage(key)
	res, err = http.Post(s.base+"sync/"+key, "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 404 {
		t.Fatal("closed app retained its endpoint")
	}
}

func TestRequestPreservesBinary(t *testing.T) {
	// Request's response wire preserves non-UTF8 bytes and HTTP errors for the
	// frontend to apply wx.request's responseType/dataType semantics.
	s, err := startResources(fstest.MapFS{"raw": {Data: []byte{0, 255, 1}}}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.http.Close()
	result, err := makeRequest(t.Context(), []byte(`{"url":"`+s.base+`raw","responseType":"arraybuffer"}`))
	if err != nil {
		t.Fatal(err)
	}
	m := result.(map[string]any)
	if m["base64"] != "AP8B" {
		t.Fatalf("binary changed: %#v", m)
	}
}

func TestRequestFormAndHTTPErrorResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		if r.Form.Get("name") != "桌面" {
			t.Errorf("unexpected form: %v", r.Form)
		}
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = w.Write([]byte(`{"accepted":false}`))
	}))
	defer server.Close()
	result, err := makeRequest(t.Context(), []byte(`{"url":"`+server.URL+`","method":"POST","header":{"content-type":"application/x-www-form-urlencoded"},"data":{"name":"桌面"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]any)["statusCode"] != 422 {
		t.Fatalf("HTTP errors must reach the success callback: %v", result)
	}
}
