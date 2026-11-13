package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

const storageLimit = 10 * 1024 * 1024

type storageRecord struct {
	Data any `json:"data"`
	Wire any `json:"wire,omitempty"`
}

// One lock covers a namespace's read/modify/commit, including disk errors.
type appStorage struct {
	mu      sync.Mutex
	file    string
	entries map[string]storageRecord
}

func openStorage(file string) (*appStorage, error) {
	s := &appStorage{file: file, entries: map[string]storageRecord{}}
	b, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(b, &s.entries); err != nil {
		return nil, fmt.Errorf("read storage: %w", err)
	}
	if s.entries == nil {
		s.entries = map[string]storageRecord{}
	}
	return s, nil
}

func atomicJSON(file string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(file), ".write-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(b)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), file)
}

func (s *appStorage) call(name string, raw json.RawMessage) (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	op := strings.TrimSuffix(name, "Sync")
	var p struct {
		Key  string `json:"key"`
		Data any    `json:"data"`
		Wire any    `json:"__diminaStorageWire"`
	}
	if strings.HasSuffix(name, "Sync") && (op == "setStorage" || op == "removeStorage") {
		if op == "setStorage" {
			var args []json.RawMessage
			if err := json.Unmarshal(raw, &args); err != nil || len(args) < 2 {
				return nil, errors.New("invalid storage arguments")
			}
			if err := json.Unmarshal(args[0], &p.Key); err != nil {
				return nil, err
			}
			if err := json.Unmarshal(args[1], &p.Data); err != nil {
				return nil, err
			}
			if len(args) > 2 {
				var meta struct {
					Wire any `json:"__diminaStorageWire"`
				}
				if err := json.Unmarshal(args[2], &meta); err != nil {
					return nil, err
				}
				p.Wire = meta.Wire
			}
		} else if err := json.Unmarshal(raw, &p.Key); err != nil {
			return nil, err
		}
	} else if len(raw) > 0 && string(raw) != "null" {
		if err := json.Unmarshal(raw, &p); err != nil {
			return nil, err
		}
	}
	if op == "getStorage" {
		r, ok := s.entries[p.Key]
		if !ok {
			if strings.HasSuffix(name, "Sync") {
				return "", nil
			}
			return nil, errors.New("data not found")
		}
		result := any(r.Data)
		if r.Wire != nil {
			result = map[string]any{"__diminaStorageResult": 1, "record": r.Wire}
		}
		if strings.HasSuffix(name, "Sync") {
			return result, nil
		}
		return map[string]any{"data": result}, nil
	}
	if op == "getStorageInfo" {
		keys := make([]string, 0, len(s.entries))
		for k := range s.entries {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b, _ := json.Marshal(s.entries)
		return map[string]any{"keys": keys, "currentSize": (len(b) + 1023) / 1024, "limitSize": storageLimit / 1024}, nil
	}
	next := make(map[string]storageRecord, len(s.entries))
	for k, v := range s.entries {
		next[k] = v
	}
	switch op {
	case "setStorage":
		next[p.Key] = storageRecord{Data: p.Data, Wire: p.Wire}
	case "removeStorage":
		delete(next, p.Key)
	case "clearStorage":
		next = map[string]storageRecord{}
	default:
		return nil, errors.New("synchronous API is not supported")
	}
	b, err := json.Marshal(next)
	if err != nil {
		return nil, err
	}
	if len(b) > storageLimit {
		return nil, errors.New("exceed storage max size 10Mb")
	}
	if err = atomicJSON(s.file, next); err != nil {
		return nil, err
	}
	s.entries = next
	return map[string]any{}, nil
}
