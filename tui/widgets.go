package main

import (
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

// ---- palette: the same neon-on-dark feel as the web app --------------------

var (
	cCyan  = lipgloss.AdaptiveColor{Light: "#007a8a", Dark: "#4fd6e6"}
	cLime  = lipgloss.AdaptiveColor{Light: "#2d7a35", Dark: "#8fd694"}
	cAmber = lipgloss.AdaptiveColor{Light: "#a86a00", Dark: "#f0b84b"}
	cPink  = lipgloss.AdaptiveColor{Light: "#b3263a", Dark: "#ff6b81"}
	cMag   = lipgloss.AdaptiveColor{Light: "#8a2ea0", Dark: "#d58cf0"}
	cDim   = lipgloss.AdaptiveColor{Light: "#6b7280", Dark: "#7b8494"}
	cText  = lipgloss.AdaptiveColor{Light: "#1f2933", Dark: "#d9dee7"}
	cLine  = lipgloss.AdaptiveColor{Light: "#c8ced6", Dark: "#2c3440"}
)

var (
	sTitle   = lipgloss.NewStyle().Bold(true).Foreground(cCyan)
	sDim     = lipgloss.NewStyle().Foreground(cDim)
	sText    = lipgloss.NewStyle().Foreground(cText)
	sBold    = lipgloss.NewStyle().Bold(true).Foreground(cText)
	sGood    = lipgloss.NewStyle().Foreground(cLime)
	sWarn    = lipgloss.NewStyle().Foreground(cAmber)
	sBad     = lipgloss.NewStyle().Foreground(cPink)
	sAccent  = lipgloss.NewStyle().Foreground(cCyan)
	sMag     = lipgloss.NewStyle().Foreground(cMag)
	sSel     = lipgloss.NewStyle().Bold(true).Foreground(cText).Background(lipgloss.AdaptiveColor{Light: "#d9f2f5", Dark: "#16323a"})
	sKey     = lipgloss.NewStyle().Bold(true).Foreground(cCyan)
	sBox     = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(cLine).Padding(0, 1)
	sBoxWarn = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(cAmber).Padding(0, 1)
)

// statusStyle: colour + glyph + word (never colour alone).
func statusStyle(status string) (string, lipgloss.Style) {
	switch status {
	case "running":
		return "● running", sGood
	case "stopped":
		return "■ stopped", sDim
	case "shelved":
		return "▤ shelved", sMag
	case "failed", "missing":
		return "✖ " + status, sBad
	case "creating", "starting", "restoring":
		return "◐ " + status, sWarn
	case "stopping", "shelving", "deleting":
		return "◑ " + status, sWarn
	}
	return "· " + status, sDim
}

func pad(s string, w int) string {
	n := lipgloss.Width(s)
	if n >= w {
		return truncate(s, w)
	}
	return s + strings.Repeat(" ", w-n)
}

// truncate cuts to w display cells, adding an ellipsis.
func truncate(s string, w int) string {
	if w <= 0 {
		return ""
	}
	if lipgloss.Width(s) <= w {
		return s
	}
	r := []rune(s)
	for len(r) > 0 && lipgloss.Width(string(r))+1 > w {
		r = r[:len(r)-1]
	}
	return string(r) + "…"
}

// wrap breaks text into lines of at most w cells (on spaces).
func wrap(s string, w int) []string {
	if w < 8 {
		w = 8
	}
	var out []string
	for _, para := range strings.Split(s, "\n") {
		line := ""
		for _, word := range strings.Fields(para) {
			for lipgloss.Width(word) > w {
				if line != "" {
					out = append(out, line)
					line = ""
				}
				out = append(out, string([]rune(word)[:w]))
				word = string([]rune(word)[w:])
			}
			switch {
			case line == "":
				line = word
			case lipgloss.Width(line)+1+lipgloss.Width(word) <= w:
				line += " " + word
			default:
				out = append(out, line)
				line = word
			}
		}
		out = append(out, line)
	}
	return out
}

// ---- sparklines -------------------------------------------------------------

var blocks = []rune("▁▂▃▄▅▆▇█")

// spark draws values as a one-line chart `width` cells wide (the newest on the right).
// max <= 0 scales to the data.
func spark(vals []float64, width int, max float64) string {
	if width <= 0 {
		return ""
	}
	if len(vals) == 0 {
		return sDim.Render(strings.Repeat("·", width))
	}
	// resample to `width` columns by averaging
	cols := make([]float64, width)
	for i := range cols {
		lo := i * len(vals) / width
		hi := (i + 1) * len(vals) / width
		if hi <= lo {
			hi = lo + 1
		}
		if hi > len(vals) {
			hi = len(vals)
		}
		sum, n := 0.0, 0
		for _, v := range vals[lo:hi] {
			if !math.IsNaN(v) {
				sum += v
				n++
			}
		}
		if n == 0 {
			cols[i] = math.NaN()
		} else {
			cols[i] = sum / float64(n)
		}
	}
	top := max
	if top <= 0 {
		for _, v := range cols {
			if !math.IsNaN(v) && v > top {
				top = v
			}
		}
	}
	if top <= 0 {
		top = 1
	}
	var b strings.Builder
	for _, v := range cols {
		if math.IsNaN(v) {
			b.WriteRune(' ')
			continue
		}
		i := int(math.Round(v / top * float64(len(blocks)-1)))
		if i < 0 {
			i = 0
		}
		if i > len(blocks)-1 {
			i = len(blocks) - 1
		}
		b.WriteRune(blocks[i])
	}
	return sAccent.Render(b.String())
}

// bar: a progress bar (setup progress and the like): violet to cyan to green as it fills.
func bar(v, max float64, width int, _ lipgloss.Style) string {
	if max <= 0 {
		max = 1
	}
	f := int(math.Round(v / max * float64(width)))
	if f < 0 {
		f = 0
	}
	if f > width {
		f = width
	}
	var b strings.Builder
	for i := 0; i < width; i++ {
		if i < f {
			c := mix(gViol, gCyan, float64(i)/float64(width))
			if v >= max {
				c = mix(gCyan, gGreen, float64(i)/float64(width))
			}
			b.WriteString(lipgloss.NewStyle().Foreground(c.color()).Render("█"))
		} else {
			b.WriteString(lipgloss.NewStyle().Foreground(mix(gBG, gBlue, 0.25).color()).Render("░"))
		}
	}
	return b.String()
}

// ---- tiles -------------------------------------------------------------------

type tile struct {
	title string
	value string
	sub   string
	tone  string // "", "warn", "bad"
	trend []float64
	max   float64
	// gauge: when gaugeMax > 0 a gradient bar shows gaugeVal/gaugeMax, and the value and the
	// trend line are coloured by how full it is.
	gaugeVal, gaugeMax float64
	trendLoad          bool // colour the trend line by how high each point is against max (else a cyan ramp)
}

func (t tile) render(w int) string { return t.renderMin(w, 0) }

// renderMin: like render, at least minLines tall inside the border (so a row of tiles lines up).
func (t tile) renderMin(w, minLines int) string {
	inner := w - 4 // border + padding
	if inner < 8 {
		inner = 8
	}
	border := lipgloss.AdaptiveColor{Light: "#b8c4d0", Dark: "#2f3b4a"}
	vs := lipgloss.NewStyle().Bold(true).Foreground(cText)
	switch t.tone {
	case "warn":
		border = lipgloss.AdaptiveColor{Light: "#a86a00", Dark: "#b8862f"}
		vs = lipgloss.NewStyle().Bold(true).Foreground(cAmber)
	case "bad":
		border = lipgloss.AdaptiveColor{Light: "#b3263a", Dark: "#c4455a"}
		vs = lipgloss.NewStyle().Bold(true).Foreground(cPink)
	}
	hasGauge := t.gaugeMax > 0
	if hasGauge && t.tone == "" {
		vs = lipgloss.NewStyle().Bold(true).Foreground(loadRGB(t.gaugeVal / t.gaugeMax).color())
	}
	lines := []string{
		lipgloss.NewStyle().Foreground(cDim).Render(strings.ToUpper(truncate(t.title, inner))),
		vs.Render(truncate(t.value, inner)),
	}
	if hasGauge {
		lines = append(lines, gauge(t.gaugeVal, t.gaugeMax, inner))
	}
	sub := wrap(t.sub, inner)
	if len(sub) > 2 {
		sub = sub[:2]
		sub[1] = truncate(sub[1], inner-1) + "…"
	}
	for len(sub) < 2 {
		sub = append(sub, "")
	}
	for _, s := range sub {
		lines = append(lines, sDim.Render(s))
	}
	if len(t.trend) > 1 {
		lines = append(lines, sparkColor(t.trend, inner, t.max, t.trendLoad))
	} else {
		lines = append(lines, sDim.Render("collecting…"))
	}
	for len(lines) < minLines { // spare space goes above the trend line
		lines = append(lines[:len(lines)-1], "", lines[len(lines)-1])
	}
	return lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(border).Padding(0, 1).Width(w - 2).Render(strings.Join(lines, "\n"))
}

// grid lays tiles out in `cols` equal columns.
func grid(tiles []tile, width, cols int) string {
	if len(tiles) == 0 {
		return ""
	}
	if cols < 1 {
		cols = 1
	}
	w := width / cols
	var rows []string
	for i := 0; i < len(tiles); i += cols {
		var cells []string
		tallest := 0
		for j := i; j < i+cols && j < len(tiles); j++ {
			if h := lipgloss.Height(tiles[j].render(w)) - 2; h > tallest {
				tallest = h
			}
		}
		for j := i; j < i+cols && j < len(tiles); j++ {
			cells = append(cells, tiles[j].renderMin(w, tallest))
		}
		rows = append(rows, lipgloss.JoinHorizontal(lipgloss.Top, cells...))
	}
	return strings.Join(rows, "\n")
}

// ---- small formatters -------------------------------------------------------

func f0(v float64) string { return fmt.Sprintf("%.0f", v) }
func f1(v float64) string { return fmt.Sprintf("%.1f", v) }

func fp(v *float64, digits int) string {
	if v == nil {
		return "—"
	}
	return fmt.Sprintf("%.*f", digits, *v)
}

func money(v float64) string { return fmt.Sprintf("$%.2f", v) }

func mins(m float64) string {
	n := int(m + 0.5)
	if n >= 120 {
		return fmt.Sprintf("%dh %dm", n/60, n%60)
	}
	return fmt.Sprintf("%dm", n)
}

func upFor(sec float64) string {
	h := int(sec) / 3600
	m := int(sec) % 3600 / 60
	switch {
	case h >= 48:
		return fmt.Sprintf("%d days", h/24)
	case h > 0:
		return fmt.Sprintf("%dh %dm", h, m)
	}
	return fmt.Sprintf("%dm", m)
}

// ago: "8 min ago" for an ISO time; "" when it can't be read.
func ago(iso string) string {
	t, err := time.Parse(time.RFC3339, iso)
	if err != nil {
		t, err = time.Parse("2006-01-02T15:04:05.000Z", iso)
		if err != nil {
			return ""
		}
	}
	d := time.Since(t)
	switch {
	case d < 0:
		return "just now"
	case d < time.Minute:
		return fmt.Sprintf("%ds ago", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%d min ago", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh %dm ago", int(d.Hours()), int(d.Minutes())%60)
	}
	return fmt.Sprintf("%d days ago", int(d.Hours()/24))
}

func providerLabel(p string) string {
	switch p {
	case "gcp":
		return "Google Cloud"
	case "aws":
		return "AWS"
	case "azure":
		return "Azure"
	case "oracle":
		return "Oracle"
	}
	return p
}

// series pulls one number per sample (skipping samples without it).
func series(samples []Sample, pick func(*Sample) (float64, bool)) []float64 {
	out := make([]float64, 0, len(samples))
	for i := range samples {
		if v, ok := pick(&samples[i]); ok {
			out = append(out, v)
		}
	}
	return out
}

func lipglossJoin(cells ...string) string {
	return lipgloss.JoinHorizontal(lipgloss.Top, cells...)
}

// ---- colour: gradients, pills, gauges ------------------------------------------

type rgb struct{ r, g, b float64 }

func (c rgb) color() lipgloss.Color {
	return lipgloss.Color(fmt.Sprintf("#%02x%02x%02x", int(c.r+0.5), int(c.g+0.5), int(c.b+0.5)))
}

func mix(a, b rgb, t float64) rgb {
	if t < 0 {
		t = 0
	}
	if t > 1 {
		t = 1
	}
	return rgb{a.r + (b.r-a.r)*t, a.g + (b.g-a.g)*t, a.b + (b.b-a.b)*t}
}

var (
	gTeal  = rgb{45, 212, 191}
	gGreen = rgb{143, 214, 148}
	gAmber = rgb{240, 184, 75}
	gRed   = rgb{255, 107, 129}
	gCyan  = rgb{79, 214, 230}
	gBlue  = rgb{86, 130, 230}
	gViol  = rgb{176, 124, 240}
	gBG    = rgb{13, 17, 23}
)

// loadRGB: how worried to be about a 0..1 reading: teal, green, amber, red.
func loadRGB(t float64) rgb {
	switch {
	case t < 0.5:
		return mix(gTeal, gGreen, t/0.5)
	case t < 0.8:
		return mix(gGreen, gAmber, (t-0.5)/0.3)
	}
	return mix(gAmber, gRed, (t-0.8)/0.2)
}

// gradientText colours each character of s from a to b.
func gradientText(s string, a, b rgb, bold bool) string {
	r := []rune(s)
	var out strings.Builder
	for i, ch := range r {
		t := 0.0
		if len(r) > 1 {
			t = float64(i) / float64(len(r)-1)
		}
		st := lipgloss.NewStyle().Foreground(mix(a, b, t).color())
		if bold {
			st = st.Bold(true)
		}
		out.WriteString(st.Render(string(ch)))
	}
	return out.String()
}

var pillInk = lipgloss.Color("#0d1117")

// pill: a small coloured label, like a status badge.
func pill(text string, bg rgb) string {
	return lipgloss.NewStyle().Bold(true).Foreground(pillInk).Background(bg.color()).Render(" " + text + " ")
}

func keyCap(k string) string {
	return lipgloss.NewStyle().Bold(true).Foreground(cCyan).Background(lipgloss.AdaptiveColor{Light: "#dbe7ee", Dark: "#1c2733"}).Render(" " + k + " ")
}

// gauge: a gradient bar (teal, green, amber, red along its length) filled to value/max.
func gauge(v, max float64, width int) string {
	if max <= 0 {
		max = 1
	}
	if width < 4 {
		width = 4
	}
	fill := v / max * float64(width)
	if fill < 0 {
		fill = 0
	}
	if fill > float64(width) {
		fill = float64(width)
	}
	var b strings.Builder
	for i := 0; i < width; i++ {
		c := loadRGB(float64(i) / float64(width-1))
		switch {
		case float64(i)+1 <= fill:
			b.WriteString(lipgloss.NewStyle().Foreground(c.color()).Render("█"))
		case float64(i) < fill: // a partial cell
			frac := fill - float64(i)
			b.WriteString(lipgloss.NewStyle().Foreground(c.color()).Render(string(blocks[int(frac*7)])))
		default:
			b.WriteString(lipgloss.NewStyle().Foreground(mix(gBG, c, 0.22).color()).Render("▁"))
		}
	}
	return b.String()
}

// sparkColor draws a trend line. mode "load" colours each column by how high it is against max
// (teal to red); anything else uses a cyan-to-violet ramp by height. Older columns fade into the
// background, so the newest reading stands out.
func sparkColor(vals []float64, width int, max float64, load bool) string {
	if width <= 0 {
		return ""
	}
	if len(vals) == 0 {
		return sDim.Render(strings.Repeat("·", width))
	}
	cols := make([]float64, width)
	for i := range cols {
		lo := i * len(vals) / width
		hi := (i + 1) * len(vals) / width
		if hi <= lo {
			hi = lo + 1
		}
		if hi > len(vals) {
			hi = len(vals)
		}
		sum, n := 0.0, 0
		for _, v := range vals[lo:hi] {
			if !math.IsNaN(v) {
				sum += v
				n++
			}
		}
		if n == 0 {
			cols[i] = math.NaN()
		} else {
			cols[i] = sum / float64(n)
		}
	}
	top := max
	if top <= 0 {
		for _, v := range cols {
			if !math.IsNaN(v) && v > top {
				top = v
			}
		}
	}
	if top <= 0 {
		top = 1
	}
	var b strings.Builder
	for i, v := range cols {
		if math.IsNaN(v) {
			b.WriteRune(' ')
			continue
		}
		ratio := v / top
		if ratio < 0 {
			ratio = 0
		}
		if ratio > 1 {
			ratio = 1
		}
		idx := int(math.Round(ratio * float64(len(blocks)-1)))
		var c rgb
		if load {
			c = loadRGB(ratio)
		} else {
			c = mix(gBlue, gCyan, ratio)
			if ratio > 0.85 {
				c = mix(gCyan, gViol, (ratio-0.85)/0.15*0.6)
			}
		}
		fade := 0.62 + 0.38*float64(i)/float64(width)
		c = mix(gBG, c, fade)
		b.WriteString(lipgloss.NewStyle().Foreground(c.color()).Render(string(blocks[idx])))
	}
	return b.String()
}

// sectionTitle: a small coloured heading.
func sectionTitle(s string) string {
	return gradientText(s, gCyan, gViol, true)
}

// statusPill: the machine's state as a coloured badge (word + colour, never colour alone).
func statusPill(status string) string {
	switch status {
	case "running":
		return pill("● RUNNING", gGreen)
	case "stopped":
		return pill("■ STOPPED", rgb{125, 135, 150})
	case "shelved":
		return pill("▤ SHELVED", gViol)
	case "failed", "missing":
		return pill("✖ "+strings.ToUpper(status), gRed)
	case "creating", "starting", "restoring":
		return pill("◐ "+strings.ToUpper(status), gAmber)
	case "stopping", "shelving", "deleting":
		return pill("◑ "+strings.ToUpper(status), gAmber)
	}
	return pill("· "+strings.ToUpper(status), rgb{125, 135, 150})
}

// panel: the bordered frame around lists.
var panel = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(lipgloss.AdaptiveColor{Light: "#b8c4d0", Dark: "#2f3b4a"}).Padding(0, 1)
