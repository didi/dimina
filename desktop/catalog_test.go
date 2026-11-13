package main

import (
	"os"
	"path/filepath"
	"testing"
)

func testPackage(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "main"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "main", "app-config.json"), []byte(`{"app":{"pages":["pages/index"]}}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "main", "logic.js"), []byte("App({})"), 0600); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestImportRejectsSymlinksAndKeepsExistingPackage(t *testing.T) {
	source := testPackage(t)
	dest := t.TempDir()
	if err := os.Symlink(filepath.Join(source, "main", "logic.js"), filepath.Join(source, "linked")); err != nil {
		t.Skip(err)
	}
	if _, err := importPackage(source, dest); err == nil {
		t.Fatal("import followed a symbolic link")
	}
	if err := os.Remove(filepath.Join(source, "linked")); err != nil {
		t.Fatal(err)
	}
	app, err := importPackage(source, dest)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := importPackage(source, dest); err == nil {
		t.Fatal("silently replaced an existing package")
	}
	if _, err := os.Stat(filepath.Join(dest, "packages", app.AppID, "main", "logic.js")); err != nil {
		t.Fatal(err)
	}
}
