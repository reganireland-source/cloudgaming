package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// The one place the app writes to: a small JSON file with the API address and
// your sign-in token (permissions 600). Sign out (L) deletes the token.
type config struct {
	API   string `json:"api"`
	Token string `json:"token"`
}

const defaultAPI = "https://cloudgaming-production.up.railway.app/api"

func configPath() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	return filepath.Join(dir, "gggh", "tui.json")
}

func loadConfig() config {
	c := config{API: defaultAPI}
	if b, err := os.ReadFile(configPath()); err == nil {
		_ = json.Unmarshal(b, &c)
	}
	if c.API == "" {
		c.API = defaultAPI
	}
	return c
}

func saveConfig(c config) error {
	p := configPath()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	return os.WriteFile(p, b, 0o600)
}
