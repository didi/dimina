// A native executable fixture for SDK process/HTTP/stdio tests. Never shipped
// inside the desktop runtime; no WebView or device hardware is involved.
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const token = "ffffffffffffffffffffffffffffffffffffffffffffffff"

type window struct {
	ID    string `json:"id"`
	AppID string `json:"appId"`
	Name  string `json:"name"`
	Ready bool   `json:"ready"`
}

func main() {
	if len(os.Args) == 3 && (os.Args[1] == "--is-running" || os.Args[1] == "--kill") {
		pid, err := strconv.Atoi(os.Args[2])
		if err != nil || pid <= 0 {
			os.Exit(2)
		}
		if os.Args[1] == "--kill" {
			process, err := os.FindProcess(pid)
			if err != nil || process.Kill() != nil {
				os.Exit(1)
			}
		} else if !processRunning(pid) {
			os.Exit(1)
		}
		return
	}
	flag.Bool("sdk-host", false, "SDK fixture mode")
	flag.String("packages-dir", "", "unused fixture resources")
	directory := flag.String("data-dir", "", "per-test state")
	flag.Parse()
	if *directory == "" {
		panic("missing --data-dir")
	}
	write := func(name, value string) {
		if err := os.WriteFile(filepath.Join(*directory, name), []byte(value), 0o600); err != nil {
			panic(err)
		}
	}
	write("pid", strconv.Itoa(os.Getpid()))
	var config struct {
		Mode string `json:"mode"`
	}
	data, err := os.ReadFile(filepath.Join(*directory, "fixture.json"))
	if err != nil {
		panic(err)
	}
	if err := json.Unmarshal(data, &config); err != nil {
		panic(err)
	}
	if config.Mode == "hang" {
		time.Sleep(time.Minute)
		return
	}
	if config.Mode == "control-failure" {
		fmt.Printf("{\"protocol\":1,\"baseUrl\":\"http://127.0.0.1:1/random/sdk/control/\",\"token\":%q}\n", token)
		time.Sleep(time.Minute)
		return
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	var mutex sync.Mutex
	windows := map[string]*window{}
	responses := map[string]chan map[string]any{}
	next := 0
	done := make(chan struct{})
	var once sync.Once
	stop := func() { once.Do(func() { close(done) }) }
	var output sync.Mutex
	emit := func(messages ...any) {
		var bytes []byte
		for _, message := range messages {
			encoded, err := json.Marshal(message)
			if err != nil {
				panic(err)
			}
			bytes = append(append(bytes, encoded...), '\n')
		}
		output.Lock()
		defer output.Unlock()
		_, _ = os.Stdout.Write(bytes)
	}
	go func() {
		if config.Mode == "backpressure" {
			// Observe the start of a real reply, then leave the rest in the pipe.
			var first [1]byte
			if _, err := os.Stdin.Read(first[:]); err == nil {
				write("blocked", "1")
			}
			return
		}
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 4096), 2<<20)
		for scanner.Scan() {
			var reply map[string]any
			if json.Unmarshal(scanner.Bytes(), &reply) != nil {
				continue
			}
			id, _ := reply["id"].(string)
			mutex.Lock()
			response := responses[id]
			delete(responses, id)
			mutex.Unlock()
			if response != nil {
				response <- reply
			}
		}
		if config.Mode != "ignore-shutdown" {
			stop()
		}
	}()
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer "+token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(request.Body).Decode(&body)
		text := func(key string) string { value, _ := body[key].(string); return value }
		method := request.URL.Path[strings.LastIndex(request.URL.Path, "/")+1:]
		if method == "closeAll" && config.Mode == "stall-close" {
			<-request.Context().Done()
			return
		}
		var value any
		mutex.Lock()
		switch method {
		case "open":
			if text("appId") == "broken" {
				mutex.Unlock()
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": "startup failed"})
				return
			}
			var app *window
			for _, candidate := range windows {
				if candidate.AppID == text("appId") {
					app = candidate
					break
				}
			}
			if app == nil {
				next++
				app = &window{ID: strconv.Itoa(next), AppID: text("appId"), Name: text("name"), Ready: true}
				if app.Name == "" {
					app.Name = app.AppID
				}
				windows[app.ID] = app
			}
			if config.Mode == "native" {
				id := "call-" + app.ID
				name := "getNetworkType"
				if strings.HasPrefix(app.AppID, "cancel") {
					name = "openSetting"
				}
				call := map[string]any{"type": "native-call", "id": id, "windowId": app.ID, "appId": app.AppID, "name": name, "params": map[string]any{"message": "你好"}}
				if app.AppID == "cancel-queued" {
					emit(call, map[string]any{"type": "native-cancel", "id": id})
				} else if app.AppID == "cancel" {
					emit(call)
				} else {
					response := make(chan map[string]any, 1)
					responses[id] = response
					mutex.Unlock()
					emit(call)
					var reply map[string]any
					select {
					case reply = <-response:
					case <-request.Context().Done():
						return
					}
					mutex.Lock()
					if failure, ok := reply["error"].(string); ok {
						app.Name = failure
					} else if result, ok := reply["value"].(map[string]any); ok {
						app.Name, _ = result["message"].(string)
					}
				}
			}
			value = *app
		case "windows":
			list := []window{}
			for _, app := range windows {
				list = append(list, *app)
			}
			value = list
		case "close":
			if app := windows[text("id")]; config.Mode == "native" && app != nil && app.AppID == "cancel" {
				emit(map[string]any{"type": "native-cancel", "id": "call-" + app.ID})
			}
			delete(windows, text("id"))
		case "closeAll":
			clear(windows)
		case "import":
			value = map[string]any{"appId": "imported", "name": "Imported", "path": "pages/index", "imported": true}
		}
		mutex.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"value": value})
		if method == "registerApi" && config.Mode == "backpressure" {
			emit(map[string]any{"type": "native-call", "id": "blocked", "appId": "test", "windowId": "window", "name": "getClipboardData", "params": map[string]any{}})
		}
	})}
	go func() { _ = server.Serve(listener); stop() }()
	protocol := 1
	if config.Mode == "wrong" {
		protocol = 2
	}
	emit(map[string]any{"protocol": protocol, "baseUrl": "http://" + listener.Addr().String() + "/random/sdk/control/", "token": token})
	<-done
	_ = server.Close()
}
