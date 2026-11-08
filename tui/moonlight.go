package main

import (
	"bytes"
	"context"
	"fmt"
	"net"
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
	args := []string{"stream", host, app,
		"--resolution", fmt.Sprintf("%dx%d", st.W, st.H), "--fps", fmt.Sprint(st.FPS), "--bitrate", fmt.Sprint(st.Kbps),
		"--video-codec", st.Codec, "--display-mode", mode, "--audio-config", "stereo",
		"--game-optimization", "--quit-after", "--no-multi-controller"}
	if st.Local { // where the sound goes: Mirror plays on the PC, Headless plays here
		if st.Mirror {
			args = append(args, "--audio-on-host", "--absolute-mouse")
		} else {
			args = append(args, "--no-audio-on-host")
		}
		if st.Overlay {
			args = append(args, "--performance-overlay")
		}
	}
	return args
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
	if !p.Online && p.Mac == "" {
		m.setNotice(p.Name+" is offline: the GGGH agent on it isn't reporting (and there is no MAC address to wake it).", true)
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

// startLocalStream: "m" on one of your own PCs: the same launcher, plus the web's Mirror / Headless modes.
func (m *model) startLocalStream(p *LocalMachine) tea.Cmd {
	if !m.localReady(p) {
		return nil
	}
	if moonlightBase() == nil && !m.demo {
		return m.installMoonlight("")
	}
	m.ml = newMLPanelFor(m, p.Name, localHost(p), "high", false, p)
	return nil
}

func (m *model) copyLocalStreamCommand(p *LocalMachine) {
	if !m.localReady(p) {
		return
	}
	pn := newMLPanelFor(m, p.Name, localHost(p), "high", false, p)
	copyText(pn.command())
	m.setNotice("Stream command copied ("+pn.app()+", "+pn.settings().summary()+", "+pn.mode+"). Paste it in a terminal.", false)
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

// ---- starting a stream ---------------------------------------------------------------------------------------

// streamState: a stream this TUI started on one of your own PCs, so the screens can be put back after it.
type streamState struct {
	name     string
	headless bool
}

type localPreparedMsg struct {
	id, name, host string
	args           []string
	headless       bool
	wasMuted       string // "true"/"false" when this computer was muted for the stream
	notes          []string
	err            error
}

type streamEndedMsg struct {
	id, name string
	notes    []string
}

func tcpUp(host string) bool {
	c, err := net.DialTimeout("tcp", net.JoinHostPort(host, "47989"), 2*time.Second)
	if err != nil {
		return false
	}
	_ = c.Close()
	return true
}

// wakeOnLAN sends the "magic packet": 6 x FF, then the PC's MAC address 16 times.
func wakeOnLAN(mac, host string) {
	hw, err := net.ParseMAC(strings.ReplaceAll(mac, "-", ":"))
	if err != nil {
		return
	}
	pkt := bytes.Repeat([]byte{0xff}, 6)
	for i := 0; i < 16; i++ {
		pkt = append(pkt, hw...)
	}
	targets := []string{"255.255.255.255:9"}
	if ip := net.ParseIP(host).To4(); ip != nil {
		targets = append(targets, fmt.Sprintf("%d.%d.%d.255:9", ip[0], ip[1], ip[2]))
	}
	for _, t := range targets {
		if c, err := net.Dial("udp", t); err == nil {
			_, _ = c.Write(pkt)
			_ = c.Close()
		}
	}
}

func osascript(script string) string {
	out, _ := exec.Command("osascript", "-e", script).Output()
	return strings.TrimSpace(string(out))
}

// launchStream starts the stream with the panel's settings. For your own PCs it first wakes the PC,
// sets its screens for the mode (Headless: virtual display, speakers muted; Mirror: own screens),
// mutes this computer in Mirror mode, then starts Moonlight and puts everything back when it ends.
func (m *model) launchStream() tea.Cmd {
	p := m.ml
	m.rememberML()
	m.ml = nil
	st := p.settings()
	args := streamArgs(p.host, p.app(), st)
	base := moonlightBase()
	if m.demo {
		note := "Demo: would "
		if p.local {
			if p.wake {
				note += "wake the PC, "
			}
			if st.Mirror {
				note += "keep its own screens (sound from the PC), "
			} else {
				note += fmt.Sprintf("switch its screens off and use a %d×%d virtual display (sound here), ", st.W, st.H)
			}
		}
		m.setNotice(note+"run "+commandLine(base, args), false)
		return nil
	}
	if base == nil {
		return m.installMoonlight("")
	}
	if !p.local {
		c := exec.Command(base[0], append(append([]string{}, base[1:]...), args...)...)
		if err := c.Start(); err != nil {
			m.setNotice("Could not start Moonlight: "+err.Error(), true)
			return nil
		}
		go func() { _ = c.Wait() }()
		m.setNotice("Moonlight is starting: "+p.app()+" from "+p.host+" ("+st.summary()+").", false)
		return nil
	}
	m.setNotice("Getting "+p.machine+" ready…", false)
	be, id, name, host, mac := m.be, p.id, p.machine, p.host, p.mac
	wake, mute, headless := p.wake && mac != "", p.mute && st.Mirror && runtime.GOOS == "darwin", !st.Mirror
	return func() tea.Msg {
		r := localPreparedMsg{id: id, name: name, host: host, args: args, headless: headless}
		if !tcpUp(host) {
			if !wake {
				r.err = fmt.Errorf("can't reach Sunshine on %s. Is the PC on?", host)
				return r
			}
			wakeOnLAN(mac, host)
			up := false
			for i := 0; i < 45 && !up; i++ {
				time.Sleep(2 * time.Second)
				up = tcpUp(host)
			}
			if !up {
				r.err = fmt.Errorf("%s didn't wake up within 90 seconds. Is Wake-on-LAN on, and is it on a network cable?", name)
				return r
			}
			time.Sleep(3 * time.Second)
			r.notes = append(r.notes, "woke the PC")
		}
		var ok bool
		var msg string
		var err error
		if headless {
			ok, msg, err = be.LocalCommand(id, "display-headless", map[string]any{"width": st.W, "height": st.H, "fps": st.FPS}, 50)
		} else {
			ok, msg, err = be.LocalCommand(id, "display-restore", nil, 20)
		}
		switch {
		case err != nil:
			r.notes = append(r.notes, "Could not reach GGGH, so the PC was left as it is.")
			r.headless = false
		case msg != "":
			r.notes = append(r.notes, msg)
		}
		if err == nil && !ok && headless {
			r.headless = true // still restore afterwards: it may have been half-applied
		}
		if mute {
			r.wasMuted = osascript("output muted of (get volume settings)")
			osascript("set volume output muted true")
		}
		return r
	}
}

// onLocalPrepared starts Moonlight, then waits for it to end in the background and puts things back.
func (m *model) onLocalPrepared(r localPreparedMsg) tea.Cmd {
	if r.err != nil {
		m.setNotice("Not streaming: "+r.err.Error(), true)
		return nil
	}
	base := moonlightBase()
	c := exec.Command(base[0], append(append([]string{}, base[1:]...), r.args...)...)
	if err := c.Start(); err != nil {
		m.setNotice("Could not start Moonlight: "+err.Error(), true)
		return m.restoreAfter(r, nil)
	}
	if m.streams == nil {
		m.streams = map[string]*streamState{}
	}
	m.streams[r.id] = &streamState{name: r.name, headless: r.headless}
	m.setNotice("Moonlight is starting: "+strings.Join(append(r.notes, "streaming from "+r.name), " · "), false)
	return m.restoreAfter(r, c)
}

// restoreAfter waits for Moonlight to exit (when c != nil), then puts the PC's screens and this computer's sound back.
func (m *model) restoreAfter(r localPreparedMsg, c *exec.Cmd) tea.Cmd {
	be := m.be
	return func() tea.Msg {
		if c != nil {
			_ = c.Wait()
		}
		var notes []string
		if r.headless {
			if _, msg, err := be.LocalCommand(r.id, "display-restore", nil, 20); err != nil {
				notes = append(notes, "couldn't put the PC's screens back (press X on it to try again)")
			} else if msg != "" {
				notes = append(notes, msg)
			}
		}
		if r.wasMuted == "false" {
			osascript("set volume output muted false")
			notes = append(notes, "sound back on here")
		}
		return streamEndedMsg{r.id, r.name, notes}
	}
}

func (m *model) onStreamEnded(r streamEndedMsg) tea.Cmd {
	delete(m.streams, r.id)
	m.setNotice("Stream from "+r.name+" ended."+map[bool]string{true: " " + strings.Join(r.notes, ", ") + ".", false: ""}[len(r.notes) > 0], false)
	m.last["local"] = time.Time{}
	return nil
}

// screensBack: "X" on one of your own PCs: switch its own screens back on (the web's "Screens back on").
func (m *model) screensBack(p *LocalMachine) tea.Cmd {
	if !p.Online {
		m.setNotice(p.Name+" is offline.", true)
		return nil
	}
	be, id, name := m.be, p.ID, p.Name
	m.setNotice("Asking "+name+" to switch its screens back on…", false)
	return func() tea.Msg {
		ok, msg, err := be.LocalCommand(id, "display-restore", nil, 20)
		if err != nil {
			return moonlightDoneMsg{"Screens back on", "", err}
		}
		if !ok {
			return moonlightDoneMsg{"Screens back on", msg, fmt.Errorf("the PC said no")}
		}
		return screensBackMsg{name, msg}
	}
}

type screensBackMsg struct{ name, msg string }
