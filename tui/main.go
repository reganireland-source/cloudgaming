// gggh-tui: a terminal version of the GGGH app (Gints Global Gaming Hubjob).
// Monitor your cloud gaming machines, start / stop / shelve / restore them,
// launch new ones, pair Moonlight and watch every operation, from the terminal.
//
//	gggh-tui                      sign in (the token is kept in ~/Library/Application Support/gggh/tui.json)
//	gggh-tui --demo               try everything with made-up machines (no login, no cost)
//	gggh-tui --api https://.../api   another backend (also GGGH_API)
//	GGGH_TOKEN=... gggh-tui       use a token from the environment
package main

import (
	"flag"
	"fmt"
	"os"

	tea "github.com/charmbracelet/bubbletea"
)

// version is set at build time: -ldflags "-X main.version=1.2.3" (Homebrew does this).
var version = "dev"

func main() {
	showVersion := flag.Bool("version", false, "print the version and exit")
	demo := flag.Bool("demo", false, "use made-up machines (no login, nothing is contacted)")
	api := flag.String("api", "", "GGGH API address (default "+defaultAPI+", or GGGH_API)")
	token := flag.String("token", "", "sign-in token (or GGGH_TOKEN)")
	flag.Parse()
	if *showVersion {
		fmt.Println("gggh-tui", version)
		return
	}

	cfg := loadConfig()
	if v := os.Getenv("GGGH_API"); v != "" {
		cfg.API = v
	}
	if *api != "" {
		cfg.API = *api
	}
	if v := os.Getenv("GGGH_TOKEN"); v != "" {
		cfg.Token = v
	}
	if *token != "" {
		cfg.Token = *token
	}

	var be Backend
	if *demo {
		be = NewDemo()
	} else {
		be = NewHTTP(cfg.API, cfg.Token)
	}
	m := newModel(be, cfg, *demo)
	if _, err := tea.NewProgram(m, tea.WithAltScreen()).Run(); err != nil {
		fmt.Fprintln(os.Stderr, "gggh-tui:", err)
		os.Exit(1)
	}
}
