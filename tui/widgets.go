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

// bar: a horizontal gauge, value/max.
func bar(v, max float64, width int, style lipgloss.Style) string {
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
	return style.Render(strings.Repeat("█", f)) + sDim.Render(strings.Repeat("░", width-f))
}

// ---- tiles -------------------------------------------------------------------

type tile struct {
	title string
	value string
	sub   string
	tone  string // "", "warn", "bad"
	trend []float64
	max   float64
}

func (t tile) render(w int) string {
	inner := w - 4 // border + padding
	if inner < 8 {
		inner = 8
	}
	vs := sBold
	switch t.tone {
	case "warn":
		vs = lipgloss.NewStyle().Bold(true).Foreground(cAmber)
	case "bad":
		vs = lipgloss.NewStyle().Bold(true).Foreground(cPink)
	}
	lines := []string{
		sDim.Render(strings.ToUpper(truncate(t.title, inner))),
		vs.Render(truncate(t.value, inner)),
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
		lines = append(lines, spark(t.trend, inner, t.max))
	} else {
		lines = append(lines, sDim.Render("collecting…"))
	}
	return sBox.Width(w - 2).Render(strings.Join(lines, "\n"))
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
		for j := i; j < i+cols && j < len(tiles); j++ {
			cells = append(cells, tiles[j].render(w))
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
