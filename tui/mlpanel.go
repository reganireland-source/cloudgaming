package main

import (
	"encoding/json"
	"fmt"
	"math"
	"os/exec"
	"runtime"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// The Moonlight launcher: the same options as the web app (components/MoonlightLauncher.tsx and
// lib/screens.ts): what to open, the quality preset, the shape of your screen, full screen or windowed.

type screenPreset struct {
	id, label, group string
	w, h             int
}

const (
	maxW, maxH = 2560, 1600 // datacenter GPUs can't drive a headless screen bigger than this
	gridW      = 4096       // big-screen (GRID driver) machines: up to 4096x2160
	gridH      = 2160
)

var screenPresets = []screenPreset{
	{"16x9", "Standard 16:9 (most monitors & TVs)", "Common", 3840, 2160},
	{"16x10", "16:10 laptop / monitor (1920×1200, 2560×1600)", "Common", 2560, 1600},
	{"mac-notch-safe", "MacBook with a notch: full screen below the notch (16:10)", "MacBook (M1–M5)", 3024, 1890},
	{"mbp14", "MacBook Pro 14″: whole screen incl. notch area (3024×1964)", "MacBook (M1–M5)", 3024, 1964},
	{"mbp16", "MacBook Pro 16″: whole screen incl. notch area (3456×2234)", "MacBook (M1–M5)", 3456, 2234},
	{"mba13", "MacBook Air 13″ M2–M5: whole screen incl. notch area (2560×1664)", "MacBook (M1–M5)", 2560, 1664},
	{"mba15", "MacBook Air 15″: whole screen incl. notch area (2880×1864)", "MacBook (M1–M5)", 2880, 1864},
	{"mac-no-notch", "MacBook Air M1 / MacBook Pro 13″ (2560×1600, 16:10)", "MacBook (M1–M5)", 2560, 1600},
	{"uw-2560", "Ultrawide 21:9: 2560×1080", "Ultrawide", 2560, 1080},
	{"uw-3440", "Ultrawide 21:9: 3440×1440", "Ultrawide", 3440, 1440},
	{"uw-3840", "Ultrawide 24:10: 3840×1600", "Ultrawide", 3840, 1600},
	{"suw-3840", "Super ultrawide 32:9: 3840×1080", "Ultrawide", 3840, 1080},
	{"suw-5120", "Super ultrawide 32:9: 5120×1440", "Ultrawide", 5120, 1440},
	{"3x2", "3:2 laptop (Surface, Framework 13): 2256×1504", "Tablets & handhelds", 2256, 1504},
	{"ipad-4x3", "iPad 4:3 (iPad Pro 13″ M4 2752×2064, iPad 2048×1536)", "Tablets & handhelds", 2752, 2064},
	{"ipad-11", "iPad Pro / Air 11″: 2388×1668", "Tablets & handhelds", 2388, 1668},
	{"steamdeck", "Steam Deck: 1280×800", "Tablets & handhelds", 1280, 800},
	{"phone", "Phone, landscape ~19.5:9: 2532×1170", "Tablets & handhelds", 2532, 1170},
}

func down8(n float64) int { return int(math.Max(8, math.Floor(n/8)*8)) }

// fitResolution: the screen's shape with about as many pixels as the preset, never more than the
// screen itself or the GPU's box; multiples of 8 (what the machine rounds to anyway).
func fitResolution(sw, sh int, presetPixels float64, capW, capH int) (int, int) {
	aspect := float64(sw) / float64(sh)
	h := math.Sqrt(math.Min(presetPixels, float64(sw*sh)) / aspect)
	w := h * aspect
	if w > float64(capW) {
		w = float64(capW)
		h = w / aspect
	}
	if h > float64(capH) {
		h = float64(capH)
		w = h * aspect
	}
	W := down8(w)
	H := int(math.Min(float64(down8(float64(capH))), math.Max(8, math.Round(float64(W)/aspect/8)*8)))
	return W, H
}

// mlSettings: what the launcher will ask Moonlight for.
type mlSettings struct {
	W, H, FPS, Kbps int
	Codec           string
	Windowed        bool
	Capped          bool // the screen is bigger than the GPU can drive: Moonlight scales the stream up
	Local           bool // your own PC: audio and screens follow the Mirror / Headless mode
	Mirror          bool // Mirror: the PC keeps its screens and plays its own sound; else Headless
	Overlay         bool // Moonlight's performance overlay
}

func (s mlSettings) summary() string {
	return fmt.Sprintf("%d×%d @ %d fps · %.1f Mbps", s.W, s.H, s.FPS, float64(s.Kbps)/1000)
}

func (s mlSettings) gbPerHour() float64 {
	return math.Round(float64(s.Kbps)*3600/8/1000/100) / 10
}

type mlScreen struct {
	id, label, group string
	w, h             int
}

// mlField is one row of the launcher: a label, how its value reads, and how ←→ changes it.
type mlField struct {
	label string
	text  func() string
	step  func(d int) tea.Cmd
}

type localConn struct {
	id, label string
	pixels    int
	fps, kbps int
	codec     string
	hint      string
}

// The web's "how good is the connection" choices (lib/localCommand.ts CONNECTIONS).
var localConns = []localConn{
	{"good", "Good · 1080p60 · 12 Mbit/s", 1920 * 1080, 60, 12000, "HEVC", "a decent connection that is not the home network"},
	{"poor", "Poor · 720p60 · 6 Mbit/s", 1280 * 720, 60, 6000, "H.264", "a mobile hotspot or busy Wi-Fi"},
	{"verypoor", "Very poor · 720p30 · 3 Mbit/s", 1280 * 720, 30, 3000, "H.264", "weak 4G, hotel or café Wi-Fi"},
	{"minimal", "Minimal · 540p30 · 1.5 Mbit/s", 960 * 540, 30, 1500, "H.264", "barely usable internet: a desktop, not a fast game"},
}

var localApps = []string{"Desktop", "Steam Big Picture"}
var localFPS = []int{30, 60, 90, 120}
var localCodecs = []string{"HEVC", "H.264", "AV1"}

type mlPanel struct {
	machine  string
	host     string
	id       string // local PC id
	local    bool   // one of your own PCs
	mac      string
	big      bool // GRID-driver machine
	def      string
	presetIx int
	presets  []string
	screens  []mlScreen
	screenIx int
	apps     []string
	appIx    int
	windowed bool
	// local PCs
	connIx    int // 0 = best (follows the screen), else localConns[connIx-1]
	fpsIx     int
	codecIx   int
	mode      string // "mirror" (control) or "headless" (gaming)
	wake      bool
	mute      bool
	overlay   bool
	virtual   bool // the PC reports a virtual display (Headless needs one)
	virtKnown bool

	fields []mlField
	field  int
}

var presetOrder = []string{"budget", "good", "high", "ultra"}

func cycle(i, d, n int) int { return (i + d + n) % n }

func newMLPanel(m *model, s *Machine, host string) *mlPanel {
	return newMLPanelFor(m, s.Name(), host, s.Quality, s.DisplayDriver == "grid", nil)
}

// newMLPanelFor builds the launcher for a cloud machine (lp == nil) or one of your own PCs.
func newMLPanelFor(m *model, name, host, quality string, big bool, lp *LocalMachine) *mlPanel {
	p := &mlPanel{machine: name, host: host, big: big, local: lp != nil, def: quality, presets: presetOrder}
	pf := m.cfg.Moonlight
	if _, ok := streamPresets[p.def]; !ok {
		p.def = "high" // the web launcher's fallback
	}
	for i, k := range presetOrder {
		if k == p.def {
			p.presetIx = i
		}
	}
	// your displays first (macOS can list them), then the shapes
	displays := detectDisplays()
	for i, d := range displays {
		p.screens = append(p.screens, mlScreen{fmt.Sprintf("attached:%d", i), fmt.Sprintf("%s (%d×%d)", d.label, d.w, d.h), "Your displays", d.w, d.h})
	}
	if lp != nil && len(displays) == 0 {
		p.screens = append(p.screens, mlScreen{"this", "This screen (size unknown: assuming 1920×1080)", "Your displays", 1920, 1080})
	}
	for _, x := range screenPresets {
		p.screens = append(p.screens, mlScreen{x.id, x.label, x.group, x.w, x.h})
	}
	want := pf.Screen
	if want == "" { // like the web: follow a non-16:9 display, else plain 16:9
		want = "16x9"
		if lp != nil && len(p.screens) > 0 {
			want = p.screens[0].id // local: "this screen"
		} else if len(p.screens) > 0 && strings.HasPrefix(p.screens[0].id, "attached:") {
			if a := float64(p.screens[0].w) / float64(p.screens[0].h); math.Abs(a-16.0/9) > 0.02 {
				want = p.screens[0].id
			}
		}
	}
	for i, x := range p.screens {
		if x.id == want {
			p.screenIx = i
		}
	}
	p.apps = streamApps
	if lp != nil {
		p.apps = localApps
		p.id, p.mac = lp.ID, lp.Mac
		p.mode = "mirror"
		if lp.DisplayMode == "headless" {
			p.mode = "headless"
		}
		p.fpsIx, p.codecIx = 1, 0 // 60 fps, HEVC
		for i, c := range localConns {
			if c.id == pf.Conn {
				p.connIx = i + 1
			}
		}
		p.wake = !pf.NoWake && p.mac != ""
		p.mute = !pf.NoMute
		p.overlay = !pf.NoOverlay
		if d, ok := lp.Status["display"].(map[string]any); ok {
			p.virtual, _ = d["virtual"].(bool)
			p.virtKnown = true
		}
	}
	for i, a := range p.apps {
		if a == pf.App {
			p.appIx = i
		}
	}
	p.windowed = pf.Windowed
	p.fields = p.buildFields(m)
	return p
}

func onOff(b bool) string {
	if b {
		return "On"
	}
	return "Off"
}

func (p *mlPanel) buildFields(m *model) []mlField {
	app := mlField{"What to open", func() string { return p.app() }, func(d int) tea.Cmd { p.appIx = cycle(p.appIx, d, len(p.apps)); return nil }}
	screen := mlField{"Your screen", func() string { return truncate(p.screens[p.screenIx].label, 62) }, func(d int) tea.Cmd { p.screenIx = cycle(p.screenIx, d, len(p.screens)); return nil }}
	display := mlField{"Display mode", func() string {
		if p.windowed {
			return "Windowed"
		}
		return "Full screen"
	}, func(int) tea.Cmd { p.windowed = !p.windowed; return nil }}
	if !p.local {
		return []mlField{app,
			{"Quality", func() string {
				k := p.presets[p.presetIx]
				t := k + " · " + streamPresets[k].label
				if k == p.def {
					t += " (machine default)"
				}
				return t
			}, func(d int) tea.Cmd { p.presetIx = cycle(p.presetIx, d, len(p.presets)); return nil }},
			screen, display}
	}
	conn := mlField{"Connection", func() string {
		if p.connIx == 0 {
			return "Best · follows my screen (home network)"
		}
		return localConns[p.connIx-1].label
	}, func(d int) tea.Cmd { p.connIx = cycle(p.connIx, d, len(localConns)+1); return nil }}
	fps := mlField{"Frame rate", func() string {
		if p.connIx > 0 {
			return fmt.Sprintf("%d fps (set by the connection)", localConns[p.connIx-1].fps)
		}
		return fmt.Sprintf("%d fps", localFPS[p.fpsIx])
	}, func(d int) tea.Cmd {
		if p.connIx == 0 {
			p.fpsIx = cycle(p.fpsIx, d, len(localFPS))
		}
		return nil
	}}
	codec := mlField{"Video", func() string {
		c := localCodecs[p.codecIx]
		if p.connIx > 0 {
			return localConns[p.connIx-1].codec + " (set by the connection)"
		}
		switch c {
		case "HEVC":
			return "HEVC (best for most)"
		case "H.264":
			return "H.264 (oldest, most compatible)"
		}
		return "AV1 (RTX 40/50 only)"
	}, func(d int) tea.Cmd {
		if p.connIx == 0 {
			p.codecIx = cycle(p.codecIx, d, len(localCodecs))
		}
		return nil
	}}
	mode := mlField{"Screens & sound", func() string {
		if p.mode == "headless" {
			return "Headless (gaming): PC screens off, sound plays here"
		}
		return "Mirror (control): PC screens stay on, sound from the PC"
	}, func(int) tea.Cmd {
		if p.mode == "headless" {
			p.mode = "mirror"
		} else {
			p.mode = "headless"
		}
		id, mode := p.id, p.mode // also kept as this PC's default, like the web
		be := m.be
		return func() tea.Msg { return modeSavedMsg{id, mode, be.SetLocalMode(id, mode)} }
	}}
	wake := mlField{"Wake the PC first", func() string {
		if p.mac == "" {
			return "Off (needs the PC's MAC address: set it in the web app)"
		}
		return onOff(p.wake)
	}, func(int) tea.Cmd {
		if p.mac != "" {
			p.wake = !p.wake
		}
		return nil
	}}
	mute := mlField{"Mute this computer", func() string {
		if p.mode != "mirror" || runtime.GOOS != "darwin" {
			return "n/a (Mirror mode on a Mac only)"
		}
		return onOff(p.mute) + " while streaming"
	}, func(int) tea.Cmd { p.mute = !p.mute; return nil }}
	overlay := mlField{"Performance overlay", func() string { return onOff(p.overlay) }, func(int) tea.Cmd { p.overlay = !p.overlay; return nil }}
	return []mlField{app, conn, screen, fps, codec, mode, display, wake, mute, overlay}
}

func (p *mlPanel) app() string { return p.apps[p.appIx] }

// settings: the same arithmetic as the web launcher.
func (p *mlPanel) settings() mlSettings {
	sc := p.screens[p.screenIx]
	if p.local {
		pixels := sc.w * sc.h
		fps, codec := localFPS[p.fpsIx], localCodecs[p.codecIx]
		kbpsFixed := 0
		if p.connIx > 0 {
			c := localConns[p.connIx-1]
			pixels, fps, codec, kbpsFixed = c.pixels, c.fps, c.codec, c.kbps
		}
		w, h := fitResolution(sc.w, sc.h, float64(pixels), 3840, 2160)
		kbps := kbpsFixed
		if kbps == 0 { // about 0.15 bit per pixel per frame
			kbps = int(math.Min(150000, math.Max(8000, math.Round(float64(w*h*fps)*0.15/1000/500)*500)))
		}
		return mlSettings{W: w, H: h, FPS: fps, Kbps: kbps, Codec: codec, Windowed: p.windowed, Local: true, Mirror: p.mode == "mirror", Overlay: p.overlay}
	}
	k := p.presets[p.presetIx]
	base := streamPresets[k]
	var bw, bh int
	fmt.Sscanf(base.res, "%dx%d", &bw, &bh)
	capW, capH := maxW, maxH
	maxScale := 1.4
	if p.big {
		capW, capH, maxScale = gridW, gridH, 2.5
	}
	budget := float64(bw * bh)
	if p.big && (k == "high" || k == "ultra") {
		budget = float64(sc.w * sc.h)
	}
	fw, fh := bw, bh
	if sc.id != "16x9" {
		fw, fh = fitResolution(sc.w, sc.h, budget, capW, capH)
	}
	scale := math.Min(maxScale, math.Max(0.6, float64(fw*fh)/float64(bw*bh)))
	kbps := int(math.Round(float64(base.kbps)*scale/500) * 500)
	capped := (sc.w > capW || sc.h > capH) && fw*fh < sc.w*sc.h && (fw == capW || fh == capH)
	return mlSettings{W: fw, H: fh, FPS: base.fps, Kbps: kbps, Codec: base.codec, Windowed: p.windowed, Capped: capped}
}

func (p *mlPanel) command() string {
	return commandLine(moonlightBase(), streamArgs(p.host, p.app(), p.settings()))
}

type modeSavedMsg struct {
	id, mode string
	err      error
}

// ---- keys ------------------------------------------------------------------------------------

func (m *model) mlKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	p := m.ml
	n := len(p.fields)
	switch k.String() {
	case "esc", "q":
		m.ml = nil
	case "up", "k":
		p.field = cycle(p.field, -1, n)
	case "down", "j", "tab":
		p.field = cycle(p.field, 1, n)
	case "left", "h":
		return m, p.fields[p.field].step(-1)
	case "right", "l", " ":
		return m, p.fields[p.field].step(1)
	case "H": // jump to the previous group of screens
		if p.fields[p.field].label == "Your screen" {
			g := p.screens[p.screenIx].group
			for i := 0; i < len(p.screens) && p.screens[p.screenIx].group == g; i++ {
				p.screenIx = cycle(p.screenIx, -1, len(p.screens))
			}
			g = p.screens[p.screenIx].group
			for p.screenIx > 0 && p.screens[p.screenIx-1].group == g {
				p.screenIx--
			}
		}
	case "L": // next group
		if p.fields[p.field].label == "Your screen" {
			g := p.screens[p.screenIx].group
			for i := 0; i < len(p.screens) && p.screens[p.screenIx].group == g; i++ {
				p.screenIx = cycle(p.screenIx, 1, len(p.screens))
			}
		}
	case "c", "C":
		copyText(p.command())
		m.setNotice("Stream command copied. Paste it in a terminal.", false)
	case "p":
		if p.local {
			host, name := p.host, p.machine
			m.ml = nil
			return m, m.pairLocal(name, host)
		}
		s := m.selected()
		m.ml = nil
		if s != nil {
			return m, m.cmdAct(s.ID, "pair", "Pair", nil)
		}
	case "enter":
		return m, m.launchStream()
	}
	return m, nil
}

func (m *model) rememberML() {
	p := m.ml
	pf := m.cfg.Moonlight
	pf.Screen, pf.App = p.screens[p.screenIx].id, p.app()
	pf.Windowed = p.windowed
	if p.local {
		pf.Conn = ""
		if p.connIx > 0 {
			pf.Conn = localConns[p.connIx-1].id
		}
		pf.NoWake, pf.NoMute, pf.NoOverlay = p.mac != "" && !p.wake, !p.mute, !p.overlay
	}
	m.cfg.Moonlight = pf
	_ = saveConfig(m.cfg)
}

// ---- the panel ------------------------------------------------------------------------------------

func (m *model) mlView() string {
	p := m.ml
	st := p.settings()
	sc := p.screens[p.screenIx]
	// short terminal (a small pane): keep the options and the stream line, drop the long notes
	tight, tiny := m.bodyHeight() < 34, m.bodyHeight() < 24
	var b strings.Builder
	b.WriteString(lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#ffffff")).Render("Moonlight · "+p.machine) + sDim.Render("  "+p.host) + "\n\n")
	for i, f := range p.fields {
		mark, val := "  ", "  "+sText.Render(f.text())+"  "
		if i == p.field {
			mark, val = sKey.Render("▌ "), sKey.Render("◂ ")+sBold.Render(f.text())+sKey.Render(" ▸")
		}
		b.WriteString(mark + sDim.Render(pad(f.label, 20)) + val + "\n")
		if f.label == "Your screen" {
			b.WriteString(strings.Repeat(" ", 22) + sDim.Render(fmt.Sprintf("  %d/%d · %s · H L jump group", p.screenIx+1, len(p.screens), sc.group)) + "\n")
		}
	}
	b.WriteString("\n")
	b.WriteString(sDim.Render("Stream: ") + sText.Render(st.summary()))
	if p.local {
		b.WriteString(sDim.Render(fmt.Sprintf(" · %s over your network", st.Codec)))
	} else {
		b.WriteString(sDim.Render(fmt.Sprintf(" · about %.1f GB per hour (billed by the cloud as data out)", st.gbPerHour())))
	}
	b.WriteString("\n" + sDim.Render(fmt.Sprintf("In the Moonlight app instead: Settings → Resolution → Custom → %d×%d", st.W, st.H)) + "\n")
	if tiny {
		b.WriteString("\n" + pill("enter  START", gGreen) + "  " + pill("esc  CLOSE", rgb{125, 135, 150}))
		return lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(gCyan.color()).Padding(0, 2).Render(b.String())
	}
	if p.local {
		// where the sound and screens go: the point of the two modes
		desc := "Mirror (control): the PC's own screens stay on at their own resolution, its sound keeps playing from the PC's own speakers, and its desktop shows here (this computer is muted). For setting things up; speed matters less."
		if p.mode == "headless" {
			desc = "Headless (gaming): the PC's screens switch off and a virtual display takes over at this screen's size and refresh rate, with the stream tuned for play. The PC's speakers are muted and the sound plays here. Everything comes back when you stop."
		}
		b.WriteString("\n" + sDim.Render(strings.Join(wrap(desc, 76), "\n")) + "\n")
		if p.mode == "headless" && p.virtKnown && !p.virtual {
			b.WriteString(sWarn.Render(strings.Join(wrap("⚠ This PC has no virtual display yet, so Headless can't switch its screens off (until then it streams as Mirror). Install one in the web app under Settings → Virtual display.", 76), "\n")) + "\n")
		}
		if p.connIx > 0 {
			b.WriteString(sAccent.Render(strings.Join(wrap(strings.Split(localConns[p.connIx-1].label, " · ")[0]+" connection: for "+localConns[p.connIx-1].hint+".", 76), "\n")) + "\n")
		}
	} else if sc.id != "16x9" {
		note := "The machine makes its screen exactly this shape, so games and the desktop fill your display with no black bars."
		if st.Capped {
			cw, ch := maxW, maxH
			who := "a datacenter GPU"
			if p.big {
				cw, ch, who = gridW, gridH, "this big-screen machine"
			}
			note += fmt.Sprintf(" Your screen is bigger than the %d×%d %s can drive, so the stream keeps its shape at up to that size and Moonlight scales it up.", cw, ch, who)
		}
		if math.Abs(float64(sc.w)/float64(sc.h)-1.543) < 0.008 {
			note += " Using the whole screen puts the top strip behind the notch; pick “below the notch” if a game's menu bar gets hidden."
		}
		b.WriteString("\n" + sDim.Render(strings.Join(wrap(note, 76), "\n")) + "\n")
	}
	if runtime.GOOS == "darwin" && !tight {
		b.WriteString("\n" + sDim.Render(strings.Join(wrap("Several monitors? Moonlight opens on the display the terminal window is on: drag this terminal there first.", 76), "\n")) + "\n")
	}
	if !tight {
		b.WriteString("\n" + sDim.Render(strings.Join(wrap(p.command(), 76), "\n")) + "\n")
	}
	b.WriteString("\n")
	b.WriteString(pill("enter  START STREAMING", gGreen) + "  " + pill("c  COPY COMMAND", gCyan) + "  " + pill("esc  CLOSE", rgb{125, 135, 150}))
	return lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(gCyan.color()).Padding(1, 3).Render(b.String())
}

// ---- finding this computer's displays (macOS) -----------------------------------------------------------

type display struct {
	label string
	w, h  int
}

func detectDisplays() []display {
	if runtime.GOOS != "darwin" {
		return nil
	}
	out, err := runWithTimeout(3*time.Second, "system_profiler", "SPDisplaysDataType", "-json")
	if err != nil {
		return nil
	}
	var root map[string]any
	if json.Unmarshal(out, &root) != nil {
		return nil
	}
	var found []display
	var walk func(v any)
	walk = func(v any) {
		switch t := v.(type) {
		case map[string]any:
			if px, ok := t["_spdisplays_pixels"].(string); ok {
				var w, h int
				if _, err := fmt.Sscanf(strings.ReplaceAll(px, " ", ""), "%dx%d", &w, &h); err == nil && w > 0 && h > 0 {
					name, _ := t["_name"].(string)
					if name == "" {
						name = "Display"
					}
					if w < h {
						w, h = h, w
					}
					found = append(found, display{name, w, h})
				}
			}
			for _, c := range t {
				walk(c)
			}
		case []any:
			for _, c := range t {
				walk(c)
			}
		}
	}
	walk(root)
	return found
}

func runWithTimeout(d time.Duration, name string, args ...string) ([]byte, error) {
	done := make(chan struct{})
	c := exec.Command(name, args...)
	var out []byte
	var err error
	go func() { out, err = c.Output(); close(done) }()
	select {
	case <-done:
		return out, err
	case <-time.After(d):
		if c.Process != nil {
			_ = c.Process.Kill()
		}
		return nil, fmt.Errorf("timed out")
	}
}
