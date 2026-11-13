package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type runtimeEvent struct {
	CallbackID string `json:"callbackId"`
	Value      any    `json:"value"`
}
type apiError struct {
	code    int
	message string
}

func (e *apiError) Error() string            { return e.message }
func failure(code int, message string) error { return &apiError{code, message} }

// A runtime belongs to one actual native window, including all asynchronous IO.
type desktopRuntime struct {
	ctx                  context.Context
	cancel               context.CancelFunc
	mu                   sync.Mutex
	work                 sync.WaitGroup
	closed               bool
	listeners            map[string]map[string]bool
	sockets              map[string]*nativeSocket
	tasks                map[string]context.CancelFunc
	earlyAborts          map[string]time.Time
	resources            *resourceServer
	owner, appID, tmpdir string
	emit                 func(runtimeEvent)
}

func newDesktopRuntime(resources *resourceServer, owner, appID string, emit func(runtimeEvent)) *desktopRuntime {
	ctx, cancel := context.WithCancel(context.Background())
	return &desktopRuntime{ctx: ctx, cancel: cancel, resources: resources, owner: owner, appID: appID, tmpdir: filepath.Join(resources.dataDir, "tmp", owner), emit: emit, listeners: map[string]map[string]bool{}, sockets: map[string]*nativeSocket{}, tasks: map[string]context.CancelFunc{}, earlyAborts: map[string]time.Time{}}
}
func (r *desktopRuntime) close() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	r.cancel()
	sockets := r.sockets
	r.sockets = map[string]*nativeSocket{}
	r.listeners = map[string]map[string]bool{}
	for _, cancel := range r.tasks {
		cancel()
	}
	r.tasks = map[string]context.CancelFunc{}
	r.earlyAborts = map[string]time.Time{}
	r.mu.Unlock()
	for _, socket := range sockets {
		socket.close()
	}
	devices.closeOwner(r.owner)
	_ = os.RemoveAll(r.tmpdir)
	go func() { r.work.Wait(); _ = os.RemoveAll(r.tmpdir) }()
}
func (r *desktopRuntime) callback(id string, value any) {
	r.mu.Lock()
	alive := !r.closed
	r.mu.Unlock()
	if alive && id != "" && r.emit != nil {
		r.emit(runtimeEvent{id, value})
	}
}
func (r *desktopRuntime) publish(event, object string, value any) {
	key := event + "/" + object
	r.mu.Lock()
	ids := make([]string, 0, len(r.listeners[key]))
	for id := range r.listeners[key] {
		ids = append(ids, id)
	}
	r.mu.Unlock()
	for _, id := range ids {
		r.callback(id, value)
	}
}
func eventMethod(name string) (bool, bool) {
	leaf := name[strings.LastIndex(name, ".")+1:]
	return strings.HasPrefix(leaf, "on"), strings.HasPrefix(leaf, "off")
}
func (r *desktopRuntime) listen(name string, p map[string]any) error {
	on, off := eventMethod(name)
	if !on && !off {
		return errors.New("invalid event method")
	}
	event := name
	if off {
		index := strings.LastIndex(name, ".") + 1
		event = name[:index] + "on" + name[index+3:]
	}
	key := event + "/" + text(p, "socketId")
	id := text(p, "callbackId")
	if id == "" {
		id = text(p, "success")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return errors.New("window is closed")
	}
	if on {
		if id == "" {
			return errors.New("callbackId is required")
		}
		if r.listeners[key] == nil {
			r.listeners[key] = map[string]bool{}
		}
		r.listeners[key][id] = true
	} else if id == "" {
		delete(r.listeners, key)
	} else {
		delete(r.listeners[key], id)
		if len(r.listeners[key]) == 0 {
			delete(r.listeners, key)
		}
	}
	return nil
}
func text(p map[string]any, name string) string { value, _ := p[name].(string); return value }
func number(p map[string]any, name string, def int) int {
	if v, ok := p[name].(float64); ok {
		return int(v)
	}
	return def
}
func boolean(p map[string]any, name string) bool { value, _ := p[name].(bool); return value }
func binary(value []byte) map[string]any {
	return map[string]any{"__diminaArrayBufferBase64": base64.StdEncoding.EncodeToString(value)}
}
func messageBytes(value any) ([]byte, error) {
	if value, ok := value.(string); ok {
		return []byte(value), nil
	}
	if value, ok := value.(map[string]any); ok {
		if data, ok := value["__diminaArrayBufferBase64"].(string); ok {
			return base64.StdEncoding.DecodeString(data)
		}
	}
	return nil, errors.New("message must be a string or ArrayBuffer")
}
func parseParams(raw json.RawMessage) (map[string]any, error) {
	p := map[string]any{}
	if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
	}
	return p, nil
}

var runtimeAPIs = []string{
	"getNetworkType", "downloadFile", "uploadFile", "uploadFileTaskAbort",
	"UDPSocket.bind", "UDPSocket.close", "UDPSocket.connect", "UDPSocket.send", "UDPSocket.write", "UDPSocket.setTTL",
	"UDPSocket.onClose", "UDPSocket.offClose", "UDPSocket.onError", "UDPSocket.offError", "UDPSocket.onListening", "UDPSocket.offListening", "UDPSocket.onMessage", "UDPSocket.offMessage",
	"TCPSocket.connect", "TCPSocket.write", "TCPSocket.close",
	"TCPSocket.onConnect", "TCPSocket.offConnect", "TCPSocket.onClose", "TCPSocket.offClose", "TCPSocket.onError", "TCPSocket.offError", "TCPSocket.onMessage", "TCPSocket.offMessage",
	"openBluetoothAdapter", "closeBluetoothAdapter", "getBluetoothAdapterState", "startBluetoothDevicesDiscovery", "stopBluetoothDevicesDiscovery", "getBluetoothDevices", "getConnectedBluetoothDevices",
	"createBLEConnection", "closeBLEConnection", "getBLEDeviceServices", "getBLEDeviceCharacteristics", "readBLECharacteristicValue", "writeBLECharacteristicValue", "notifyBLECharacteristicValueChange", "getBLEDeviceRSSI", "getBLEMTU",
	"onBluetoothAdapterStateChange", "offBluetoothAdapterStateChange", "onBluetoothDeviceFound", "offBluetoothDeviceFound", "onBLEConnectionStateChange", "offBLEConnectionStateChange", "onBLECharacteristicValueChange", "offBLECharacteristicValueChange",
}

func (r *desktopRuntime) supports(name string) bool {
	for _, candidate := range runtimeAPIs {
		if candidate == name {
			return true
		}
	}
	for _, candidate := range []string{"connectSocket", "sendSocketMessage", "closeSocket", "onSocketOpen", "onSocketClose", "onSocketError", "onSocketMessage", "offSocketOpen", "offSocketClose", "offSocketError", "offSocketMessage", "SocketTask.send", "SocketTask.close", "SocketTask.onOpen", "SocketTask.onClose", "SocketTask.onError", "SocketTask.onMessage", "SocketTask.offOpen", "SocketTask.offClose", "SocketTask.offError", "SocketTask.offMessage", "request", "setClipboardData", "getClipboardData", "chooseMessageFile", "scanCode", "setStorage", "getStorage", "removeStorage", "clearStorage", "getStorageInfo"} {
		if name == candidate || (strings.Contains(candidate, "Storage") && name == candidate+"Sync") {
			return true
		}
	}
	return false
}
func (r *desktopRuntime) invoke(ctx context.Context, name string, raw json.RawMessage) (any, error) {
	p, err := parseParams(raw)
	if err != nil {
		return nil, err
	}
	if on, off := eventMethod(name); on || off {
		return nil, r.listen(name, p)
	}
	if strings.HasPrefix(name, "UDPSocket.") || strings.HasPrefix(name, "TCPSocket.") {
		result, err := r.socketCall(name, p)
		if err != nil && name != "UDPSocket.bind" {
			r.publish(strings.Split(name, ".")[0]+".onError", text(p, "socketId"), map[string]any{"errMsg": err.Error()})
		}
		return result, err
	}
	switch name {
	case "getNetworkType":
		interfaces, err := net.Interfaces()
		if err != nil {
			return nil, err
		}
		kind := "none"
		for _, network := range interfaces {
			if network.Flags&net.FlagUp != 0 && network.Flags&net.FlagLoopback == 0 {
				addresses, _ := network.Addrs()
				if len(addresses) > 0 {
					kind = "unknown"
					break
				}
			}
		}
		return map[string]any{"networkType": kind}, nil
	case "downloadFile":
		return r.download(ctx, p)
	case "uploadFile":
		return r.upload(ctx, p)
	case "uploadFileTaskAbort":
		r.abortTask(text(p, "taskId"))
		return nil, nil
	default:
		if strings.Contains(name, "Bluetooth") || strings.Contains(name, "BLE") {
			return devices.invoke(ctx, r, name, p)
		}
		return nil, fmt.Errorf("%s is not supported on desktop", name)
	}
}
