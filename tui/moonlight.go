package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

// Moonlight from the terminal: pair this computer, then stream, without leaving the TUI.
// The settings match the web app's launcher (MoonlightLauncher.tsx): the machine's quality preset
// and the apps defined in the Sunshine container.

type streamPreset struct {
	res   string
	fps   int
	kbps  int
	codec string
	label string
}

var streamPresets = map[string]streamPreset{
	"budget": {"1280x720", 30, 3000, "H.264", "720p30 · 3 Mbps"},
	"good":   {"1920x1080", 60, 8000, "HEVC", "1080p60 · 8 Mbps"},
	"high":   {"2560x1440", 60, 12000, "HEVC", "1440p60 · 12 Mbps"},
	"ultra":  {"2560x1440", 60, 20000, "HEVC", "1440p60 · 20 Mbps"},
}

var streamApps = []string{"Desktop", "Steam (Big Picture)", "Steam", "Battle.net", "Discord", "Google Chrome", "Heroic Games Launcher", "Lutris", "Firefox"}

type moonlightDoneMsg struct {
	label string
	out   string
	err   error
}

type brewDoneMsg struct{ err error }

// moonlightBase: the command that starts Moonlight on this computer (nil when it isn't installed).
func moonlightBase() []string {
	for _, n := range []string{"moonlight", "Moonlight"} {
		if p, err := exec.LookPath(n); err == nil {
			return []string{p}
		}
	}
	home, _ := os.UserHomeDir()
	for _, p := range []string{
		"/Applications/Moonlight.app/Contents/MacOS/Moonlight",
		filepath.Join(home, "Applications/Moonlight.app/Contents/MacOS/Moonlight"),
		"/opt/homebrew/bin/moonlight", "/usr/local/bin/moonlight",
	} {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return []string{p}
		}
	}
	if _, err := exec.LookPath("flatpak"); err == nil {
		if exec.Command("flatpak", "info", "com.moonlight_stream.Moonlight").Run() == nil {
			return []string{"flatpak", "run", "com.moonlight_stream.Moonlight"}
		}
	}
	return nil
}

// streamArgs: the Moonlight command line for the chosen settings (see mlSettings).
func streamArgs(host, app string, st mlSettings) []string {
	mode := "fullscreen"
	if st.Windowed {
		mode = "windowed"
	}
	return []string{"stream", host, app,
		"--resolution", fmt.Sprintf("%dx%d", st.W, st.H), "--fps", fmt.Sprint(st.FPS), "--bitrate", fmt.Sprint(st.Kbps),
		"--video-codec", st.Codec, "--display-mode", mode, "--audio-config", "stereo",
		"--game-optimization", "--quit-after", "--no-multi-controller"}
}

func shellQuote(s string) string {
	if strings.ContainsAny(s, " ()'\"") {
		return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
	}
	return s
}

// commandLine is what you would paste into a terminal.
func commandLine(base []string, args []string) string {
	if base == nil {
		base = []string{"moonlight"}
	}
	var parts []string
	for _, a := range append(append([]string{}, base...), args...) {
		parts = append(parts, shellQuote(a))
	}
	return strings.Join(parts, " ")
}

// installMoonlight offers the Homebrew install (macOS) or says where to get Moonlight.
func (m *model) installMoonlight(then string) tea.Cmd {
	if _, err := exec.LookPath("brew"); err == nil && runtime.GOOS == "darwin" {
		return m.confirm("Moonlight isn't installed on this Mac", "Install it now with Homebrew (brew install --cask moonlight)? "+then, false,
			func(m *model, _ string) tea.Cmd {
				if m.demo {
					m.setNotice("Demo: would run brew install --cask moonlight.", false)
					return nil
				}
				return tea.ExecProcess(exec.Command("brew", "install", "--cask", "moonlight"), func(err error) tea.Msg { return brewDoneMsg{err} })
			})
	}
	m.prompt = &prompt{kind: pInfo, title: "Moonlight isn't installed", body: "Get it from https://moonlight-stream.org (macOS: brew install --cask moonlight; Linux: flatpak install flathub com.moonlight_stream.Moonlight). Then press the key again."}
	return nil
}

func (m *model) onBrewDone(msg brewDoneMsg) tea.Cmd {
	if msg.err != nil {
		m.setNotice("The Moonlight install did not finish: "+msg.err.Error(), true)
		return nil
	}
	m.setNotice("Moonlight is installed. Press p to pair, then m to stream.", false)
	return nil
}

// offerPair: after GGGH has picked a PIN, run `moonlight pair` here (GGGH types the PIN into Sunshine).
func (m *model) offerPair(host, pin string) tea.Cmd {
	base := moonlightBase()
	cmd := commandLine(base, []string{"pair", host, "--pin", pin})
	if m.demo {
		base = []string{"moonlight"}
	}
	if base == nil {
		copyText(cmd)
		return m.installMoonlight("The pair command is copied to your clipboard for later: " + cmd)
	}
	m.prompt = &prompt{kind: pConfirm, title: "Pair Moonlight now?",
		body: "GGGH has picked PIN " + pin + " and types it into Sunshine for you (it keeps trying for 3 minutes). Run this here?\n\n" + cmd + "\n\n(n copies it instead.)",
		run: func(m *model, _ string) tea.Cmd {
			if m.demo {
				m.setNotice("Demo: would run "+cmd, false)
				return nil
			}
			m.setNotice("Pairing… GGGH is entering the PIN into Sunshine (up to 3 minutes).", false)
			args := []string{"pair", host, "--pin", pin}
			return func() tea.Msg {
				ctx, cancel := context.WithTimeout(context.Background(), 200*time.Second)
				defer cancel()
				c := exec.CommandContext(ctx, base[0], append(append([]string{}, base[1:]...), args...)...)
				out, err := c.CombinedOutput()
				return moonlightDoneMsg{"Pair", strings.TrimSpace(string(out)), err}
			}
		}}
	m.prompt.onNo = func(m *model) { copyText(cmd); m.setNotice("Pair command copied to the clipboard.", false) }
	return nil
}

func (m *model) onMoonlightDone(msg moonlightDoneMsg) tea.Cmd {
	if msg.err != nil {
		out := msg.out
		if len(out) > 160 {
			out = out[len(out)-160:]
		}
		m.setNotice(msg.label+" failed: "+msg.err.Error()+" "+strings.ReplaceAll(out, "\n", " "), true)
		return nil
	}
	m.setNotice(msg.label+" done. Press m to stream.", false)
	return tea.Batch(m.cmdOps(""), m.cmdMachines())
}

// streamHost: the address Moonlight should connect to.
func (m *model) streamHost(s *Machine) string {
	if c := m.conn[s.ID]; c != nil && c.IP != "" {
		return c.IP
	}
	return s.IP
}

// startStreamPicker: "m" opens the launcher (app, quality, your screen, full screen).
func (m *model) startStreamPicker(s *Machine) tea.Cmd {
	host := m.streamHost(s)
	if host == "" {
		m.setNotice("This machine has no address yet.", true)
		return nil
	}
	if c := m.conn[s.ID]; c != nil && !c.Setup.Ready && c.Status != "" && len(c.Setup.Stages) > 0 {
		m.setNotice("Setup isn't finished: streaming works once the Connect tab says Ready to stream.", true)
		return nil
	}
	if moonlightBase() == nil && !m.demo {
		return m.installMoonlight("")
	}
	m.ml = newMLPanel(m, s, host)
	return nil
}

// copyStreamCommand: "M" copies the command with the launcher's remembered settings.
func (m *model) copyStreamCommand(s *Machine) {
	host := m.streamHost(s)
	if host == "" {
		m.setNotice("This machine has no address yet.", true)
		return
	}
	p := newMLPanel(m, s, host)
	copyText(p.command())
	m.setNotice("Stream command copied ("+p.app()+", "+p.settings().summary()+"). Paste it in a terminal.", false)
}

// ---- your own PCs --------------------------------------------------------------------------------------

// localHost: where Moonlight finds a local PC (its address on your network).
func localHost(p *LocalMachine) string { return p.LanIP }

func (m *model) localReady(p *LocalMachine) bool {
	if !p.Online {
		m.setNotice(p.Name+" is offline: the GGGH agent on it isn't reporting.", true)
		return false
	}
	if localHost(p) == "" {
		m.setNotice(p.Name+" has no network address yet.", true)
		return false
	}
	if v, ok := p.Status["sunshine"].(string); ok && strings.EqualFold(v, "NotInstalled") {
		m.setNotice("Sunshine isn't installed on "+p.Name+": install it there first (it streams the PC).", true)
		return false
	}
	return true
}

// startLocalStream: "m" on one of your own PCs: the same launcher, streaming from its LAN address.
func (m *model) startLocalStream(p *LocalMachine) tea.Cmd {
	if !m.localReady(p) {
		return nil
	}
	if moonlightBase() == nil && !m.demo {
		return m.installMoonlight("")
	}
	m.ml = newMLPanelFor(m, p.Name, localHost(p), "high", false, true)
	return nil
}

func (m *model) copyLocalStreamCommand(p *LocalMachine) {
	if !m.localReady(p) {
		return
	}
	pn := newMLPanelFor(m, p.Name, localHost(p), "high", false, true)
	copyText(pn.command())
	m.setNotice("Stream command copied ("+pn.app()+", "+pn.settings().summary()+"). Paste it in a terminal.", false)
}

// pairLocal: "p" on one of your own PCs. GGGH can't type the PIN into a PC at home, so Moonlight
// shows the PIN here and you enter it in that PC's Sunshine page (opened for you).
func (m *model) pairLocal(name, host string) tea.Cmd {
	base := moonlightBase()
	if base == nil && !m.demo {
		return m.installMoonlight("")
	}
	cmd := commandLine(base, []string{"pair", host})
	url := "https://" + host + ":47990"
	return m.confirm("Pair Moonlight with "+name+"?",
		"Moonlight prints a PIN here. Enter it in Sunshine's page on that PC ("+url+", opened for you now; accept the certificate warning and sign in). Run this?\n\n"+cmd, false,
		func(m *model, _ string) tea.Cmd {
			if m.demo {
				m.setNotice("Demo: would run "+cmd, false)
				return nil
			}
			openURL(url)
			c := exec.Command(base[0], append(append([]string{}, base[1:]...), "pair", host)...)
			return tea.ExecProcess(c, func(err error) tea.Msg { return moonlightDoneMsg{"Pair", "", err} })
		})
}
