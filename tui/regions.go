package main

import (
	"fmt"
	"sort"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type regionsMsg struct {
	r       *RegionAccessResp
	err     error
	refresh bool
}

func (m *model) cmdRegions(refresh bool) tea.Cmd {
	be := m.be
	return func() tea.Msg {
		r, err := be.RegionAccess(refresh)
		return regionsMsg{r, err, refresh}
	}
}

// status order: what you can use first, then what's fixable, then what isn't possible
var statusRank = map[string]int{"ready": 0, "no-quota": 1, "not-enabled": 2, "unknown": 3, "not-offered": 4, "not-connected": 5}

func regionPill(status string) string {
	switch status {
	case "ready":
		return pill("READY", gGreen)
	case "no-quota":
		return pill("NO QUOTA", gAmber)
	case "not-enabled":
		return pill("NOT ENABLED", gAmber)
	case "not-offered":
		return pill("NOT SOLD HERE", rgb{125, 135, 150})
	case "not-connected":
		return pill("NOT CONNECTED", rgb{125, 135, 150})
	}
	return pill("COULDN'T CHECK", gRed)
}

// regionList: the chosen cloud's regions, usable ones first (or only those, with f).
func (m *model) regionList() []RegionAccess {
	c := m.cloud()
	if c == nil {
		return nil
	}
	var out []RegionAccess
	for _, r := range c.Regions {
		if m.readyOnly && r.Status != "ready" {
			continue
		}
		out = append(out, r)
	}
	sort.SliceStable(out, func(a, b int) bool {
		ra, rb := statusRank[out[a].Status], statusRank[out[b].Status]
		if ra != rb {
			return ra < rb
		}
		return out[a].Name < out[b].Name
	})
	return out
}

func (m *model) cloud() *CloudAccess {
	if m.regions == nil || m.cloudSel >= len(m.regions.Clouds) {
		return nil
	}
	return &m.regions.Clouds[m.cloudSel]
}

func (m *model) regionsKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	list := m.regionList()
	switch k.String() {
	case "left", "h", "shift+tab":
		if m.regions != nil && len(m.regions.Clouds) > 0 {
			m.cloudSel = (m.cloudSel + len(m.regions.Clouds) - 1) % len(m.regions.Clouds)
			m.regSel = 0
			m.rvp.GotoTop()
		}
	case "right", "l", "tab":
		if m.regions != nil && len(m.regions.Clouds) > 0 {
			m.cloudSel = (m.cloudSel + 1) % len(m.regions.Clouds)
			m.regSel = 0
			m.rvp.GotoTop()
		}
	case "up", "k":
		if m.regSel > 0 {
			m.regSel--
			m.rvp.GotoTop()
		}
	case "down", "j":
		if m.regSel < len(list)-1 {
			m.regSel++
			m.rvp.GotoTop()
		}
	case "f":
		m.readyOnly = !m.readyOnly
		m.regSel = 0
		m.setNotice(map[bool]string{true: "Showing only regions you can use now.", false: "Showing every region."}[m.readyOnly], false)
	case "pgdown", "ctrl+d", "J":
		m.rvp.HalfViewDown()
	case "pgup", "ctrl+u", "K":
		m.rvp.HalfViewUp()
	case "r":
		m.last["regions"] = zeroTime
		m.setNotice("Reloading (the server keeps results for 10 minutes).", false)
	case "R":
		m.regionsLoading = true
		m.setNotice("Checking every region live with each cloud: this can take a minute…", false)
		return m, m.cmdRegions(true)
	case "c":
		if cmd := m.fixCommand(list); cmd != "" {
			copyText(cmd)
			m.setNotice("Command copied to the clipboard.", false)
		} else {
			m.setNotice("This region has no command to copy.", true)
		}
	case "o":
		if u := m.fixURL(list); u != "" {
			openURL(u)
			m.setNotice("Opened "+u, false)
		}
	}
	return m, nil
}

func (m *model) selectedRegion(list []RegionAccess) *RegionAccess {
	if m.regSel >= 0 && m.regSel < len(list) {
		return &list[m.regSel]
	}
	return nil
}

func (m *model) fixCommand(list []RegionAccess) string { return fixCmd(m.selectedRegion(list)) }

func (m *model) fixURL(list []RegionAccess) string { return fixLink(m.selectedRegion(list)) }

// fixCmd: the one command that asks for what's missing in this region (quota first).
func fixCmd(r *RegionAccess) string {
	if r == nil {
		return ""
	}
	for _, q := range r.QuotaDetail {
		if q.Short && q.Request != nil && q.Request.CLI != "" {
			return q.Request.CLI
		}
	}
	if r.Fix != nil && r.Fix.CLI != "" {
		return r.Fix.CLI
	}
	for _, q := range r.QuotaDetail {
		if q.Request != nil && q.Request.CLI != "" {
			return q.Request.CLI
		}
	}
	return ""
}

func fixLink(r *RegionAccess) string {
	if r == nil {
		return ""
	}
	if r.Fix != nil && r.Fix.ConsoleURL != "" {
		return r.Fix.ConsoleURL
	}
	for _, q := range r.QuotaDetail {
		if q.Request != nil && q.Request.ConsoleURL != "" {
			return q.Request.ConsoleURL
		}
	}
	return ""
}

// ---- the page ----------------------------------------------------------------------------

func (m *model) regionsView(w, h int) string {
	if m.regions == nil {
		if m.regionsErr != "" {
			return sBad.Render("✖ Couldn't check your cloud regions: " + m.regionsErr)
		}
		return m.spin.View() + sDim.Render(" checking what each cloud lets you run (the first check can take a minute)…")
	}
	// cloud tabs, with how much of each you can use
	var tabs []string
	for i, c := range m.regions.Clouds {
		ready := 0
		for _, r := range c.Regions {
			if r.Status == "ready" {
				ready++
			}
		}
		label := c.Label
		switch {
		case !c.Connected:
			label += " · not connected"
		default:
			label += fmt.Sprintf(" · %d/%d ready", ready, len(c.Regions))
		}
		switch {
		case i == m.cloudSel:
			tabs = append(tabs, pill(label, gCyan))
		case !c.Connected:
			tabs = append(tabs, sDim.Render(" "+label+" "))
		default:
			tabs = append(tabs, sText.Render(" "+label+" "))
		}
	}
	head := strings.Join(tabs, " ")
	c := m.cloud()
	if c == nil {
		return head
	}
	if c.Error != nil {
		return head + "\n\n" + sBad.Render("✖ "+c.Error.Title)
	}
	if !c.Connected {
		return head + "\n\n" + sDim.Render(strings.Join(wrap("This cloud isn't connected yet. Add its keys in the web app (Config page) and its regions, GPU quotas and what you can run appear here.", w), "\n"))
	}
	list := m.regionList()
	if m.regSel >= len(list) {
		m.regSel = maxInt(0, len(list)-1)
	}
	listW := 52
	if w < 120 {
		listW = 44
	}
	var l strings.Builder
	title := fmt.Sprintf("REGIONS (%d)", len(list))
	if m.readyOnly {
		title += " · ready only"
	}
	l.WriteString(sectionTitle(title) + "\n\n")
	bodyH := h - 3
	start := 0
	if m.regSel >= bodyH {
		start = m.regSel - bodyH + 1
	}
	for i := start; i < len(list) && i < start+bodyH; i++ {
		r := list[i]
		bar := "  "
		name := sText.Render(pad(truncate(r.Name, 18), 19))
		if i == m.regSel {
			bar = lipgloss.NewStyle().Foreground(gCyan.color()).Render("▌ ")
			name = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#ffffff")).Render(pad(truncate(r.Name, 18), 19))
		}
		q := ""
		if len(r.Quotas) > 0 && r.Quotas[0].Limit > 0 {
			q = gauge(r.Quotas[0].Used, r.Quotas[0].Limit, 6) + sDim.Render(fmt.Sprintf(" %.0f/%.0f", r.Quotas[0].Used, r.Quotas[0].Limit))
		}
		l.WriteString(bar + name + regionPill(r.Status) + " " + q + "\n")
	}
	if len(list) == 0 {
		l.WriteString(sDim.Render("No regions to show. Press f to show all."))
	}
	left := panel.Width(listW - 2).Height(h - 2).Render(strings.TrimRight(l.String(), "\n"))
	right := ""
	if r := m.selectedRegion(list); r != nil {
		m.rvp.Width, m.rvp.Height = w-listW-2, h-2
		m.rvp.SetContent(m.regionDetail(r, w-listW-4))
		right = withMoreHint(m.rvp)
	}
	if w < 100 {
		return head + "\n" + left
	}
	return head + "\n" + lipgloss.JoinHorizontal(lipgloss.Top, left, " ", right)
}

func runMark(ok *bool, na bool) string {
	switch {
	case na:
		return sDim.Render(" – ")
	case ok == nil:
		return sWarn.Render(" ? ")
	case *ok:
		return sGood.Render(" ✓ ")
	}
	return sBad.Render(" ✗ ")
}

func (m *model) regionDetail(r *RegionAccess, w int) string {
	var b strings.Builder
	b.WriteString(lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#ffffff")).Render(r.Name) + "  " + regionPill(r.Status) + sDim.Render("  "+r.Region) + "\n")
	b.WriteString(sText.Render(strings.Join(wrap(r.Summary, w), "\n")) + "\n")
	if len(r.NotSold) > 0 {
		b.WriteString(sDim.Render("Not sold here: "+strings.Join(r.NotSold, ", ")) + "\n")
	}
	if len(r.MissingGPUs) > 0 {
		b.WriteString(sWarn.Render("No free quota for: "+strings.Join(r.MissingGPUs, ", ")) + "\n")
	}

	// quotas: what you may use against what you do use
	quotas := r.QuotaDetail
	if len(quotas) == 0 {
		for _, q := range r.Quotas {
			u := q.Used
			quotas = append(quotas, QuotaDetail{Label: q.Label, Used: &u, Limit: q.Limit, Unit: q.Unit})
		}
	}
	if len(quotas) > 0 {
		b.WriteString("\n" + sectionTitle("YOUR QUOTAS (what the cloud lets you use)") + "\n")
		for _, q := range quotas {
			used := "usage not reported"
			g := ""
			if q.Used != nil {
				used = fmt.Sprintf("%.0f of %.0f %s", *q.Used, q.Limit, q.Unit)
				g = gauge(*q.Used, maxFloat(q.Limit, 1), 14) + "  "
			} else {
				used = fmt.Sprintf("limit %.0f %s", q.Limit, q.Unit)
			}
			line := sText.Render(pad(truncate(q.Label, 30), 31)) + g + sText.Render(used)
			if q.Short {
				line += "  " + pill("TOO LOW", gAmber)
			}
			b.WriteString(line + "\n")
			if len(q.Unlocks) > 0 {
				b.WriteString(sDim.Render("   unlocks: "+truncate(strings.Join(q.Unlocks, ", "), w-14)) + "\n")
			}
			for _, p := range q.Pending {
				b.WriteString(sWarn.Render(fmt.Sprintf("   ◐ request open: %.0f %s", p.Requested, p.Status)) + "\n")
			}
			for _, p := range q.Denied {
				b.WriteString(sBad.Render(fmt.Sprintf("   ✖ request denied: %.0f %s", p.Requested, p.Status)) + "\n")
			}
		}
	}
	if r.PendingNote != "" {
		b.WriteString(sDim.Render(strings.Join(wrap(r.PendingNote, w), "\n")) + "\n")
	}

	// what can run here
	if len(r.Run) > 0 {
		b.WriteString("\n" + sectionTitle("WHAT YOU CAN RUN HERE") + "\n")
		b.WriteString(sDim.Render(pad("", 30)+pad("normal", 9)+pad("spot", 7)+pad("big screen", 12)+"big + spot") + "\n")
		for _, row := range r.Run {
			line := sText.Render(pad(truncate(row.Label, 11), 12)) + sDim.Render(pad(truncate(row.Shape, 17), 18))
			for _, mode := range []string{"normal", "spot", "big", "bigSpot"} {
				c := row.Cells[mode]
				pw := map[string]int{"normal": 9, "spot": 7, "big": 12, "bigSpot": 8}[mode]
				line += pad(runMark(c.OK, c.NA), pw)
			}
			b.WriteString(line + "\n")
		}
		b.WriteString(sDim.Render("✓ works now  ✗ blocked  – not offered  ? can't tell") + "\n")
		// say why for the blocked ones in the selected region
		seen := map[string]bool{}
		for _, row := range r.Run {
			for _, c := range row.Cells {
				if c.OK != nil && !*c.OK && c.Why != "" && !seen[c.Why] {
					seen[c.Why] = true
					b.WriteString(sWarn.Render("▲ ") + sDim.Render(truncate(c.Why, w-3)) + "\n")
				}
			}
		}
	}

	// the fix
	if r.Fix != nil && (len(r.Fix.Steps) > 0 || r.Fix.CLI != "") {
		b.WriteString("\n" + sectionTitle("HOW TO FIX IT") + "\n")
		for i, s := range r.Fix.Steps {
			b.WriteString(sDim.Render(fmt.Sprintf("%d. ", i+1)) + strings.Join(wrap(s, w-3), "\n   ") + "\n")
		}
		if r.Fix.ConsoleURL != "" {
			b.WriteString(sDim.Render("Console: ") + sAccent.Render(truncate(r.Fix.ConsoleURL, w-10)) + sDim.Render("   (o opens it)") + "\n")
		}
	}
	if cmd := fixCmd(r); cmd != "" {
		b.WriteString("\n" + sDim.Render("Command (c copies it):") + "\n" + lipgloss.NewStyle().Foreground(cAmber).Render(strings.Join(wrap(cmd, w), "\n")) + "\n")
	}
	return strings.TrimRight(b.String(), "\n")
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}
