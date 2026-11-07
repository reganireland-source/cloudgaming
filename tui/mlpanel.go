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

type mlPanel struct {
	machine  string
	host     string
	big      bool // GRID-driver machine
	def      string
	presetIx int
	presets  []string
	screens  []mlScreen
	screenIx int
	appIx    int
	windowed bool
	field    int
}

var presetOrder = []string{"budget", "good", "high", "ultra"}

func newMLPanel(m *model, s *Machine, host string) *mlPanel {
	p := &mlPanel{machine: s.Name(), host: host, big: s.DisplayDriver == "grid", def: s.Quality, presets: presetOrder}
	if _, ok := streamPresets[p.def]; !ok {
		p.def = "high" // the web launcher's fallback
	}
	for i, k := range presetOrder {
		if k == p.def {
			p.presetIx = i
		}
	}
	// your displays first (macOS can list them), then the shapes
	for i, d := range detectDisplays() {
		p.screens = append(p.screens, mlScreen{fmt.Sprintf("attached:%d", i), fmt.Sprintf("%s (%d×%d)", d.label, d.w, d.h), "Your displays", d.w, d.h})
	}
	for _, x := range screenPresets {
		p.screens = append(p.screens, mlScreen{x.id, x.label, x.group, x.w, x.h})
	}
	want := m.cfg.Moonlight.Screen
	if want == "" { // like the web: follow a non-16:9 display, else plain 16:9
		want = "16x9"
		if len(p.screens) > 0 && strings.HasPrefix(p.screens[0].id, "attached:") {
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
	for i, a := range streamApps {
		if a == m.cfg.Moonlight.App {
			p.appIx = i
		}
	}
	p.windowed = m.cfg.Moonlight.Windowed
	return p
}

func (p *mlPanel) app() string { return streamApps[p.appIx] }

// settings: the same arithmetic as the web launcher.
func (p *mlPanel) settings() mlSettings {
	k := p.presets[p.presetIx]
	base := streamPresets[k]
	var bw, bh int
	fmt.Sscanf(base.res, "%dx%d", &bw, &bh)
	capW, capH := maxW, maxH
	maxScale := 1.4
	if p.big {
		capW, capH, maxScale = gridW, gridH, 2.5
	}
	sc := p.screens[p.screenIx]
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

// ---- keys ------------------------------------------------------------------------------------

func (m *model) mlKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	p := m.ml
	step := func(d int) {
		switch p.field {
		case 0:
			p.appIx = (p.appIx + d + len(streamApps)) % len(streamApps)
		case 1:
			p.presetIx = (p.presetIx + d + len(p.presets)) % len(p.presets)
		case 2:
			p.screenIx = (p.screenIx + d + len(p.screens)) % len(p.screens)
		case 3:
			p.windowed = !p.windowed
		}
	}
	switch k.String() {
	case "esc", "q":
		m.ml = nil
	case "up", "k":
		p.field = (p.field + 3) % 4
	case "down", "j", "tab":
		p.field = (p.field + 1) % 4
	case "left", "h":
		step(-1)
	case "right", "l", " ":
		step(1)
	case "H": // jump to the previous group of screens
		if p.field == 2 {
			g := p.screens[p.screenIx].group
			for p.screens[p.screenIx].group == g {
				p.screenIx = (p.screenIx + len(p.screens) - 1) % len(p.screens)
			}
			g = p.screens[p.screenIx].group
			for p.screenIx > 0 && p.screens[p.screenIx-1].group == g {
				p.screenIx--
			}
		}
	case "L": // next group
		if p.field == 2 {
			g := p.screens[p.screenIx].group
			for p.screens[p.screenIx].group == g {
				p.screenIx = (p.screenIx + 1) % len(p.screens)
			}
		}
	case "c", "C":
		copyText(p.command())
		m.setNotice("Stream command copied. Paste it in a terminal.", false)
	case "p":
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
	m.cfg.Moonlight = mlPrefs{Screen: p.screens[p.screenIx].id, App: p.app(), Windowed: p.windowed}
	_ = saveConfig(m.cfg)
}

// launchStream starts Moonlight (detached) with the panel's settings.
func (m *model) launchStream() tea.Cmd {
	p := m.ml
	m.rememberML()
	m.ml = nil
	args := streamArgs(p.host, p.app(), p.settings())
	if m.demo {
		m.setNotice("Demo: would run "+commandLine(moonlightBase(), args), false)
		return nil
	}
	base := moonlightBase()
	if base == nil {
		return m.installMoonlight("")
	}
	c := exec.Command(base[0], append(append([]string{}, base[1:]...), args...)...)
	if err := c.Start(); err != nil {
		m.setNotice("Could not start Moonlight: "+err.Error(), true)
		return nil
	}
	go func() { _ = c.Wait() }()
	m.setNotice("Moonlight is starting: "+p.app()+" from "+p.host+" ("+p.settings().summary()+").", false)
	return nil
}

// ---- the panel ------------------------------------------------------------------------------------

func (m *model) mlView() string {
	p := m.ml
	st := p.settings()
	sc := p.screens[p.screenIx]
	key := p.presets[p.presetIx]
	pr := streamPresets[key]
	val := func(field int, text string) string {
		if p.field == field {
			return sKey.Render("◂ ") + sBold.Render(text) + sKey.Render(" ▸")
		}
		return "  " + sText.Render(text) + "  "
	}
	row := func(field int, label, text string) string {
		mark := "  "
		if p.field == field {
			mark = sKey.Render("▌ ")
		}
		return mark + sDim.Render(pad(label, 14)) + val(field, text)
	}
	quality := key + " · " + pr.label
	if key == p.def {
		quality += " (machine default)"
	}
	mode := "Full screen"
	if p.windowed {
		mode = "Windowed"
	}
	screen := sc.label
	pos := sDim.Render(fmt.Sprintf("  %d/%d · %s · H L jump group", p.screenIx+1, len(p.screens), sc.group))
	var b strings.Builder
	b.WriteString(lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#ffffff")).Render("Moonlight · "+p.machine) + sDim.Render("  "+p.host) + "\n\n")
	b.WriteString(row(0, "What to open", p.app()) + "\n")
	b.WriteString(row(1, "Quality", quality) + "\n")
	b.WriteString(row(2, "Your screen", truncate(screen, 62)) + "\n")
	b.WriteString(strings.Repeat(" ", 16) + pos + "\n")
	b.WriteString(row(3, "Display mode", mode) + "\n\n")
	b.WriteString(sDim.Render("Stream: ") + sText.Render(st.summary()) + sDim.Render(fmt.Sprintf(" · about %.1f GB per hour (billed by the cloud as data out)", st.gbPerHour())) + "\n")
	b.WriteString(sDim.Render(fmt.Sprintf("In the Moonlight app instead: Settings → Resolution → Custom → %d×%d", st.W, st.H)) + "\n")
	if sc.id != "16x9" {
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
	if runtime.GOOS == "darwin" {
		b.WriteString("\n" + sDim.Render(strings.Join(wrap("Several monitors? Moonlight opens on the display the terminal window is on: drag this terminal there first.", 76), "\n")) + "\n")
	}
	b.WriteString("\n" + sDim.Render(strings.Join(wrap(p.command(), 76), "\n")) + "\n\n")
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
