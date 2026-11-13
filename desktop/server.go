package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

func secret() string {
	var b [24]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

type resourceServer struct {
	assets               fs.FS
	dataDir              string
	origin, base, prefix string
	http                 *http.Server
	mu                   sync.RWMutex
	runtimes             map[string]*desktopRuntime
	stores               map[string]*appStorage
	namespaces           map[string]*appStorage
	files                map[string]selectedFile
	packageRoot          string
	sdk                  *sdkControl
}

type selectedFile struct{ path, owner string }

func startResources(assets fs.FS, dataDir string) (*resourceServer, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	s := &resourceServer{assets: assets, dataDir: dataDir, runtimes: map[string]*desktopRuntime{}, stores: map[string]*appStorage{}, files: map[string]selectedFile{}}
	s.origin = "http://" + ln.Addr().String()
	s.prefix = "/" + secret() + "/"
	s.base = s.origin + s.prefix
	s.http = &http.Server{Handler: s, ReadHeaderTimeout: 5e9, MaxHeaderBytes: 32 << 10}
	go func() { _ = s.http.Serve(ln) }()
	return s, nil
}

func (s *resourceServer) addStorage(appID string) (string, *appStorage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.namespaces == nil {
		s.namespaces = map[string]*appStorage{}
	}
	store := s.namespaces[appID]
	if store == nil {
		var err error
		store, err = openStorage(filepath.Join(s.dataDir, "storage", appID+".json"))
		if err != nil {
			return "", nil, err
		}
		// Retain one transaction lock and snapshot per namespace across window
		// lifetimes; accepted calls from a closing window may still be finishing.
		s.namespaces[appID] = store
	}
	key := secret()
	s.stores[key] = store
	return key, store, nil
}

func (s *resourceServer) removeStorage(key string) {
	s.mu.Lock()
	delete(s.stores, key)
	delete(s.runtimes, key)
	for id, file := range s.files {
		if file.owner == key {
			delete(s.files, id)
		}
	}
	s.mu.Unlock()
}

func (s *resourceServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// The random prefix also keeps other websites and local processes from guessing
	// the resource/API URLs. Reject browser cross-origin writes before dispatch.
	if !strings.HasPrefix(r.URL.Path, s.prefix) || r.Host != strings.TrimPrefix(s.origin, "http://") {
		http.NotFound(w, r)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != s.origin {
		http.Error(w, "origin is not allowed", http.StatusForbidden)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, s.prefix)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if s.sdk != nil && strings.HasPrefix(path, "sdk/control/") {
		s.sdk.serve(w, r, strings.TrimPrefix(path, "sdk/control/"))
		return
	}
	if strings.HasPrefix(path, "sync/") {
		if r.Method != http.MethodPost {
			http.Error(w, "POST required", 405)
			return
		}
		s.mu.RLock()
		store := s.stores[strings.TrimPrefix(path, "sync/")]
		runtime := s.runtimes[strings.TrimPrefix(path, "sync/")]
		s.mu.RUnlock()
		if store == nil {
			http.NotFound(w, r)
			return
		}
		var req struct {
			Name   string          `json:"name"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 12<<20)).Decode(&req); err != nil {
			writeResult(w, nil, err)
			return
		}
		if runtime != nil && (strings.HasPrefix(req.Name, "UDPSocket.") || strings.HasPrefix(req.Name, "TCPSocket.") || ((strings.HasPrefix(req.Name, "onBluetooth") || strings.HasPrefix(req.Name, "offBluetooth") || strings.HasPrefix(req.Name, "onBLE") || strings.HasPrefix(req.Name, "offBLE")) && runtime.supports(req.Name)) || req.Name == "canIUse") {
			if req.Name == "canIUse" {
				var schema string
				err := json.Unmarshal(req.Params, &schema)
				supported := runtime.supports(schema)
				if !supported && s.sdk != nil {
					for _, name := range s.sdk.native.names(runtime.appID) {
						if name == schema {
							supported = true
							break
						}
					}
				}
				writeResult(w, supported, err)
			} else {
				value, err := runtime.invoke(r.Context(), req.Name, req.Params)
				writeResult(w, value, err)
			}
			return
		}
		if !strings.HasSuffix(req.Name, "Sync") {
			writeResult(w, nil, errors.New("synchronous API required"))
			return
		}
		value, err := store.call(req.Name, req.Params)
		writeResult(w, value, err)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", 405)
		return
	}
	if strings.HasPrefix(path, "files/") {
		s.mu.RLock()
		file := s.files[strings.TrimPrefix(path, "files/")]
		s.mu.RUnlock()
		if file.path == "" {
			http.NotFound(w, r)
			return
		}
		content, err := os.Open(file.path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		defer content.Close()
		info, err := content.Stat()
		if err != nil || !info.Mode().IsRegular() {
			http.NotFound(w, r)
			return
		}
		// ServeFile redirects a URL ending in index.html to its directory,
		// which is not a granted file URL. Serve the selected file itself.
		http.ServeContent(w, r, info.Name(), info.ModTime(), content)
		return
	}
	if strings.HasPrefix(path, "packages/") {
		parts := strings.SplitN(strings.TrimPrefix(path, "packages/"), "/", 2)
		if len(parts) != 2 || !appIDPattern.MatchString(parts[0]) || !fs.ValidPath(parts[1]) {
			http.NotFound(w, r)
			return
		}
		var source fs.FS = s.assets
		if info, err := os.Stat(filepath.Join(s.dataDir, "packages", parts[0])); err == nil && info.IsDir() {
			source = os.DirFS(filepath.Join(s.dataDir, "packages"))
		} else if s.packageRoot != "" {
			source = os.DirFS(s.packageRoot)
		}
		http.StripPrefix(s.prefix+"packages/", http.FileServerFS(source)).ServeHTTP(w, r)
		return
	}
	if path == "" {
		path = "index.html"
	}
	if !fs.ValidPath(path) {
		http.NotFound(w, r)
		return
	}
	// Vite fingerprints files under assets/. Their URL and the random server
	// prefix change with a new build/session, so they can be reused on reopen.
	if strings.HasPrefix(path, "assets/") {
		if info, err := fs.Stat(s.assets, path); err == nil && !info.IsDir() {
			w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
		}
	}
	// fs.FS-backed serving supports the range requests made by audio/video.
	http.StripPrefix(s.prefix, http.FileServerFS(s.assets)).ServeHTTP(w, r)
}

func writeResult(w http.ResponseWriter, value any, err error) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if err != nil {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": err.Error()})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"value": value})
}
