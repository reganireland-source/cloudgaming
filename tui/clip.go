package main

import (
	"os"
	"os/exec"
	"runtime"
	"strings"

	"github.com/muesli/termenv"
)

// copyText puts text on the clipboard: pbcopy on a Mac, wl-copy / xclip on
// Linux, and the terminal's own clipboard (OSC 52) when neither is there.
func copyText(s string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("pbcopy")
	default:
		if _, err := exec.LookPath("wl-copy"); err == nil {
			cmd = exec.Command("wl-copy")
		} else if _, err := exec.LookPath("xclip"); err == nil {
			cmd = exec.Command("xclip", "-selection", "clipboard")
		}
	}
	if cmd != nil {
		cmd.Stdin = strings.NewReader(s)
		if cmd.Run() == nil {
			return
		}
	}
	termenv.NewOutput(os.Stdout).Copy(s)
}

// openURL opens a web address in the default browser.
func openURL(u string) {
	if !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
		return
	}
	switch runtime.GOOS {
	case "darwin":
		_ = exec.Command("open", u).Start()
	case "linux":
		_ = exec.Command("xdg-open", u).Start()
	}
}
