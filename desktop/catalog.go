package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
)

type miniProgram struct {
	AppID    string `json:"appId"`
	Name     string `json:"name"`
	Path     string `json:"path,omitempty"`
	Imported bool   `json:"imported"`
}

var appIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,96}$`)

func validatePackage(fsys fs.FS) (string, error) {
	b, err := fs.ReadFile(fsys, "main/app-config.json")
	if err != nil {
		return "", errors.New("请选择包含 main/app-config.json 的小程序编译产物目录")
	}
	var cfg struct {
		App struct {
			Pages   []string `json:"pages"`
			Entry   string   `json:"entryPagePath"`
			Runtime string   `json:"runtimeType"`
		} `json:"app"`
	}
	if err = json.Unmarshal(b, &cfg); err != nil {
		return "", fmt.Errorf("invalid app-config.json: %w", err)
	}
	if _, err = fs.Stat(fsys, "main/logic.js"); err != nil {
		return "", errors.New("package has no main/logic.js")
	}
	if cfg.App.Runtime == "game" {
		return "game", nil
	}
	if cfg.App.Entry != "" {
		return cfg.App.Entry, nil
	}
	if len(cfg.App.Pages) == 0 {
		return "", errors.New("package has no pages")
	}
	return cfg.App.Pages[0], nil
}

func loadCatalog(assets fs.FS, dataDir string) ([]miniProgram, error) {
	b, err := fs.ReadFile(assets, "appList.json")
	if err != nil {
		return nil, err
	}
	var apps []miniProgram
	if err = json.Unmarshal(b, &apps); err != nil {
		return nil, err
	}
	valid := apps[:0]
	for _, app := range apps {
		if !appIDPattern.MatchString(app.AppID) {
			continue
		}
		sub, err := fs.Sub(assets, app.AppID)
		if err != nil {
			continue
		}
		if _, err = validatePackage(sub); err == nil {
			valid = append(valid, app)
		}
	}
	imported, err := os.ReadDir(filepath.Join(dataDir, "packages"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	for _, dir := range imported {
		if !dir.IsDir() || !appIDPattern.MatchString(dir.Name()) {
			continue
		}
		base := filepath.Join(dataDir, "packages", dir.Name())
		b, err := os.ReadFile(filepath.Join(base, "desktop.json"))
		var app miniProgram
		if err != nil || json.Unmarshal(b, &app) != nil || app.AppID != dir.Name() {
			continue
		}
		if _, err = validatePackage(os.DirFS(base)); err != nil {
			continue
		}
		app.Imported = true
		// Imported versions override a built-in with the same ID.
		for i := len(valid) - 1; i >= 0; i-- {
			if valid[i].AppID == app.AppID {
				valid = append(valid[:i], valid[i+1:]...)
			}
		}
		valid = append(valid, app)
	}
	sort.SliceStable(valid, func(i, j int) bool { return valid[i].Name < valid[j].Name })
	return valid, nil
}

func importPackage(source, dataDir string) (miniProgram, error) {
	entry, err := validatePackage(os.DirFS(source))
	if err != nil {
		return miniProgram{}, err
	}
	id := filepath.Base(source)
	if !appIDPattern.MatchString(id) {
		sum := sha256.Sum256([]byte(source))
		id = "local_" + hex.EncodeToString(sum[:8])
	}
	app := miniProgram{AppID: id, Name: filepath.Base(source), Path: entry, Imported: true}
	if b, e := os.ReadFile(filepath.Join(source, "config.json")); e == nil {
		var meta struct {
			AppID string `json:"appId"`
			Name  string `json:"name"`
		}
		if json.Unmarshal(b, &meta) == nil {
			if appIDPattern.MatchString(meta.AppID) {
				app.AppID = meta.AppID
			}
			if meta.Name != "" {
				app.Name = meta.Name
			}
		}
	}
	root := filepath.Join(dataDir, "packages")
	if err = os.MkdirAll(root, 0700); err != nil {
		return app, err
	}
	dest := filepath.Join(root, app.AppID)
	if _, err = os.Stat(dest); err == nil {
		return app, errors.New("该小程序已导入，请先使用现有版本")
	}
	tmp, err := os.MkdirTemp(root, ".import-")
	if err != nil {
		return app, err
	}
	defer os.RemoveAll(tmp)
	var total int64
	count := 0
	err = filepath.WalkDir(source, func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if d.Type()&os.ModeSymlink != 0 {
			return errors.New("package must not contain symbolic links")
		}
		rel, e := filepath.Rel(source, path)
		if e != nil {
			return e
		}
		if d.IsDir() {
			return os.MkdirAll(filepath.Join(tmp, rel), 0700)
		}
		info, e := d.Info()
		if e != nil {
			return e
		}
		if !info.Mode().IsRegular() {
			return errors.New("package contains a non-regular file")
		}
		total += info.Size()
		count++
		if total > 256<<20 || count > 20000 {
			return errors.New("package exceeds 256 MiB or 20000 files")
		}
		in, e := os.Open(path)
		if e != nil {
			return e
		}
		out, e := os.OpenFile(filepath.Join(tmp, rel), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if e != nil {
			in.Close()
			return e
		}
		written, copyErr := io.Copy(out, io.LimitReader(in, info.Size()+1))
		in.Close()
		closeErr := out.Close()
		if copyErr != nil {
			return copyErr
		}
		if written != info.Size() {
			return errors.New("package changed while importing")
		}
		return closeErr
	})
	if err != nil {
		return app, err
	}
	if _, err = validatePackage(os.DirFS(tmp)); err != nil {
		return app, err
	}
	if err = atomicJSON(filepath.Join(tmp, "desktop.json"), app); err != nil {
		return app, err
	}
	return app, os.Rename(tmp, dest)
}
