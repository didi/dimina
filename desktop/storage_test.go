package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestStorageSyncPersistenceAndNamespace(t *testing.T) {
	file := filepath.Join(t.TempDir(), "app-a.json")
	s, err := openStorage(file)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.call("setStorageSync", json.RawMessage(`["answer",true,{"__diminaStorageWire":{"data":"true","dataType":"Boolean","entrySize":50}}]`))
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := openStorage(file)
	if err != nil {
		t.Fatal(err)
	}
	value, err := reopened.call("getStorageSync", json.RawMessage(`{"key":"answer"}`))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(value)
	if string(b) != `{"__diminaStorageResult":1,"record":{"data":"true","dataType":"Boolean","entrySize":50}}` {
		t.Fatalf("unexpected wire result: %s", b)
	}
	other, _ := openStorage(filepath.Join(filepath.Dir(file), "app-b.json"))
	if value, _ := other.call("getStorageSync", json.RawMessage(`{"key":"answer"}`)); value != "" {
		t.Fatalf("another app read %v", value)
	}
	if _, err := reopened.call("removeStorageSync", json.RawMessage(`"answer"`)); err != nil {
		t.Fatal(err)
	}
	if value, _ := reopened.call("getStorageSync", json.RawMessage(`{"key":"answer"}`)); value != "" {
		t.Fatal("remove was not committed")
	}
}

func TestStorageFailedWriteDoesNotMutateMemory(t *testing.T) {
	root := t.TempDir()
	blocker := filepath.Join(root, "blocker")
	if err := os.WriteFile(blocker, []byte("file"), 0600); err != nil {
		t.Fatal(err)
	}
	s := &appStorage{file: filepath.Join(blocker, "store.json"), entries: map[string]storageRecord{}}
	if _, err := s.call("setStorageSync", json.RawMessage(`["key","value"]`)); err == nil {
		t.Fatal("write succeeded through a file")
	}
	if len(s.entries) != 0 {
		t.Fatal("failed transaction changed in-memory storage")
	}
}
