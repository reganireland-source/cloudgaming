package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/viewport"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

func placeCenter(s string, w, h int) string {
	return lipgloss.Place(w, h, lipgloss.Center, lipgloss.Center, s)
}

func (m *model) View() string {
	if m.quitting {
		return ""
	}
	if !m.authed {
		return m.loginView()
	}
	bodyH := m.bodyHeight()
	var body string
	switch {
	case m.prompt != nil:
		body = placeCenter(m.promptView(), m.w, bodyH)
	case m.help:
		body = placeCenter(m.helpView(), m.w, bodyH)
	default:
		switch m.screen {
		case scrMachines:
			body = m.machinesView(m.w, bodyH)
		case scrActivity:
			body = m.activityView(m.w, bodyH)
		case scrLocal:
			body = m.localView(m.w, bodyH)
		case scrWizard:
			body = m.wizardView(m.w, bodyH)
		}
	}
	// exactly bodyH lines so the footer stays at the bottom
	lines := strings.Split(body, "\n")
	if len(lines) > bodyH {
		lines = lines[:bodyH]
	}
	for len(lines) < bodyH {
		lines = append(lines, "")
	}
	for i := range lines { // never wider than the terminal
		lines[i] = ansi.Truncate(lines[i], m.w, "")
	}
	return m.header() + "\n" + strings.Join(lines, "\n") + "\n" + strings.Join(m.footerLines(), "\n")
}

// ---- header / footer ---------------------------------------------------------------------

func light(name string, svc Svc, known bool) string {
	switch {
	case !known:
		return sDim.Render("○ " + name)
	case svc.Connected:
		return sGood.Render("●") + " " + sDim.Render(name)
	}
	return sBad.Render("●") + " " + sDim.Render(name)
}

func (m *model) header() string {
	var lights []string
	st := m.status
	if st != nil {
		lights = append(lights, light("API", st.Backend, true), light("DB", st.Database, true), sDim.Render("│"))
		for _, k := range []string{"aws", "azure", "gcp", "oracle"} {
			s, ok := st.Providers[k]
			lights = append(lights, light(strings.ToUpper(k), s, ok))
		}
	} else {
		lights = append(lights, sDim.Render("○ checking…"))
	}
	left := sTitle.Render("GGGH") + "  " + strings.Join(lights, "  ")
	right := ""
	if sp := m.spend; sp != nil {
		full := sDim.Render("TODAY ") + sText.Render(money(sp.Today.Usd)) + sDim.Render("  WTD ") + sText.Render(money(sp.WeekToDate.Usd)) + sDim.Render("  MTD ") + sText.Render(money(sp.MonthToDate.Usd))
		if sp.ProjectedMonthUsd > 0 {
			full += sDim.Render("  →  ") + sText.Render(money(sp.ProjectedMonthUsd))
		}
		short := sDim.Render("MTD ") + sText.Render(money(sp.MonthToDate.Usd))
		switch {
		case lipgloss.Width(left)+2+lipgloss.Width(full) <= m.w:
			right = full
		case lipgloss.Width(left)+2+lipgloss.Width(short) <= m.w:
			right = short
		}
	}
	if m.demo && lipgloss.Width(left)+lipgloss.Width(right)+8 <= m.w {
		right = sWarn.Render("DEMO ") + right
	}
	gap := m.w - lipgloss.Width(left) - lipgloss.Width(right)
	if gap < 1 {
		gap = 1
	}
	line1 := left + strings.Repeat(" ", gap) + right

	tab := func(n, label string, on bool) string {
		if on {
			return sSel.Render(" " + n + " " + label + " ")
		}
		return sDim.Render(" "+n+" ") + sText.Render(label) + " "
	}
	line2 := tab("1", "Machines", m.screen == scrMachines) + tab("2", "Activity", m.screen == scrActivity) + tab("3", "Local PCs", m.screen == scrLocal)
	if m.screen == scrWizard {
		line2 += sSel.Render(" n New machine ")
	}
	rule := sDim.Render(strings.Repeat("─", m.w))
	return line1 + "\n" + line2 + "\n" + rule
}

// footerLines: a rule, one line for notices and errors, then EVERY shortcut that works
// right now, wrapped to the terminal width.
func (m *model) footerLines() []string {
	rule := sDim.Render(strings.Repeat("─", m.w))
	var msg string
	switch {
	case m.notice != "":
		st := sGood
		if m.noticeBad {
			st = sBad
		}
		msg = st.Render(truncate(m.notice, m.w))
	case m.err != "":
		msg = sBad.Render(truncate("✖ "+m.err, m.w))
	}
	out := []string{rule, msg}
	return append(out, wrapHints(m.hintPairs(), m.w)...)
}

// wrapHints lays "key label" pairs out in as many lines as the width needs.
func wrapHints(pairs [][2]string, w int) []string {
	var lines []string
	cur := ""
	for _, p := range pairs {
		item := sKey.Render(p[0]) + " " + sDim.Render(p[1])
		if cur != "" && lipgloss.Width(cur)+3+lipgloss.Width(item) > w {
			lines = append(lines, cur)
			cur = ""
		}
		if cur != "" {
			cur += sDim.Render(" · ")
		}
		cur += item
	}
	if cur != "" {
		lines = append(lines, cur)
	}
	return lines
}

func (m *model) hintPairs() [][2]string {
	global := [][2]string{{"1 2 3", "screens"}, {"n", "new machine"}, {"ctrl+r", "refresh"}, {"?", "help"}, {"L", "sign out"}, {"q", "quit"}}
	switch {
	case m.prompt != nil:
		switch m.prompt.kind {
		case pInput:
			return [][2]string{{"enter", "save"}, {"esc", "cancel"}}
		case pInfo:
			return [][2]string{{"enter", "close"}}
		}
		return [][2]string{{"y", "yes"}, {"n / esc", "no"}}
	case m.help:
		return [][2]string{{"any key", "close"}}
	case m.screen == scrWizard && m.wiz != nil:
		return m.wizardHints()
	case m.screen == scrMachines:
		s := m.selected()
		p := [][2]string{{"↑↓", "machine"}, {"←→", "tab"}}
		if s != nil {
			switch {
			case s.Busy():
				p = append(p, [2]string{"e", "rename"}, [2]string{"w", "window"}, [2]string{"J K", "scroll"})
			case s.Status == "running":
				p = append(p, [2]string{"x", "stop"}, [2]string{"z", "shelve"}, [2]string{"p", "pair Moonlight"}, [2]string{"e", "rename"},
					[2]string{"u", "update script"}, [2]string{"U", "update+restart"}, [2]string{"R", "resume setup"}, [2]string{"$", "spot/on-demand"},
					[2]string{"y", "sync"}, [2]string{"D", "delete"}, [2]string{"w", "window"}, [2]string{"c", "copy password"}, [2]string{"v", "show password"},
					[2]string{"C", "copy IP"}, [2]string{"o", "open Sunshine"}, [2]string{"J K", "scroll"})
			case s.Status == "stopped":
				p = append(p, [2]string{"s", "start"}, [2]string{"z", "shelve"}, [2]string{"e", "rename"}, [2]string{"$", "spot/on-demand"},
					[2]string{"R", "resume setup"}, [2]string{"y", "sync"}, [2]string{"D", "delete"}, [2]string{"C", "copy IP"}, [2]string{"J K", "scroll"})
			case s.Status == "shelved":
				p = append(p, [2]string{"r", "restore"}, [2]string{"e", "rename"}, [2]string{"$", "spot/on-demand"}, [2]string{"D", "delete"})
			default:
				p = append(p, [2]string{"e", "rename"}, [2]string{"y", "sync"}, [2]string{"D", "delete"})
			}
		}
		return append(p, global...)
	case m.screen == scrActivity:
		if m.opv != nil {
			return [][2]string{{"↑↓", "scroll"}, {"pgup pgdn", "page"}, {"G", "latest"}, {"esc", "back to list"}, {"1", "machines"}, {"ctrl+c", "quit"}}
		}
		return append([][2]string{{"↑↓", "choose"}, {"enter", "open log"}, {"r", "refresh"}}, global...)
	case m.screen == scrLocal:
		return append([][2]string{{"↑↓", "PC"}, {"w", "window"}, {"J K", "scroll"}, {"r", "refresh"}}, global...)
	}
	return global
}

func (m *model) wizardHints() [][2]string {
	w := m.wiz
	base := [][2]string{{"enter", "next"}, {"esc", "back"}}
	if w.opts == nil {
		return [][2]string{{"esc", "cancel"}}
	}
	switch w.step {
	case stPurpose:
		return [][2]string{{"↑↓", "choose"}, {"enter", "next"}, {"esc", "cancel"}}
	case stSize:
		return [][2]string{{"↑↓", "choose"}, {"1 2 3", "light / standard / heavy"}, {"enter", "next"}, {"esc", "back"}}
	case stOptions:
		return [][2]string{{"↑↓ tab", "field"}, {"space", "toggle spot"}, {"← →", "auto-stop"}, {"enter", "next"}, {"esc", "back"}}
	case stExtras:
		return [][2]string{{"↑↓", "choose"}, {"space", "tick / untick"}, {"enter", "next"}, {"esc", "back"}}
	case stReview:
		return [][2]string{{"enter", "LAUNCH"}, {"esc", "back"}}
	}
	return append([][2]string{{"↑↓", "choose"}}, base...)
}

// ---- machines ----------------------------------------------------------------------------

func machineRow(x Machine, selected bool, w int) string {
	badge, st := statusStyle(x.Status)
	l1 := truncate(x.Name(), w-2)
	l2 := st.Render(badge) + sDim.Render(fmt.Sprintf(" · %s · %s/h", x.Provider, money(x.CostPerHour)))
	if x.Spot {
		l2 += sWarn.Render(" spot")
	}
	if selected {
		return sKey.Render("▸ ") + sBold.Render(l1) + "\n  " + l2
	}
	return "  " + sText.Render(l1) + "\n  " + l2
}

func (m *model) machinesView(w, h int) string {
	if !m.loaded {
		return m.spin.View() + " loading your machines…"
	}
	if len(m.machines) == 0 {
		return sDim.Render("No machines yet.") + "\n\n" + sDim.Render("Press ") + sKey.Render("n") + sDim.Render(" to launch one: choose what it's for and GGGH picks the size and tools.")
	}
	listW := 38
	wide := w >= 100
	var list strings.Builder
	list.WriteString(sAccent.Render(fmt.Sprintf("MACHINES (%d)", len(m.machines))) + "\n")
	for i, x := range m.machines {
		list.WriteString(machineRow(x, i == m.sel, listW-4) + "\n")
	}
	s := m.selected()
	if !wide {
		// stacked: a compact list on top, the detail underneath
		var rows []string
		for i, x := range m.machines {
			badge, st := statusStyle(x.Status)
			line := pad(x.Name(), 30) + st.Render(badge)
			if i == m.sel {
				line = sKey.Render("▸ ") + sBold.Render(line)
			} else {
				line = "  " + line
			}
			rows = append(rows, line)
		}
		top := strings.Join(rows, "\n")
		return top + "\n" + sDim.Render(strings.Repeat("─", w)) + "\n" + m.detailView(s, w, h-len(rows)-1)
	}
	left := sBox.Width(listW - 2).Height(h - 2).Render(strings.TrimRight(list.String(), "\n"))
	right := m.detailView(s, w-listW-1, h)
	return lipgloss.JoinHorizontal(lipgloss.Top, left, " ", right)
}

func (m *model) detailView(s *Machine, w, h int) string {
	if s == nil {
		return ""
	}
	badge, st := statusStyle(s.Status)
	var head []string
	title := sBold.Render(s.Name()) + "  " + st.Render(badge)
	if s.Busy() {
		title += " " + m.spin.View()
	}
	head = append(head, title)
	sub := fmt.Sprintf("%s · %s · %s", providerLabel(s.Provider), s.Region, s.InstanceType)
	if s.Spot {
		sub += " · spot"
	}
	if s.DisplayDriver == "grid" {
		sub += " · big screen"
	}
	head = append(head, sDim.Render(truncate(sub, w)))
	l3 := fmt.Sprintf("%s/h", money(s.CostPerHour))
	if s.IP != "" {
		l3 = "IP " + s.IP + " · " + l3
	}
	if s.DiskSizeGb > 0 {
		l3 += fmt.Sprintf(" · disk %.0f GB", s.DiskSizeGb)
	}
	if s.Status == "running" && s.LastStarted != "" {
		l3 += " · started " + ago(s.LastStarted)
	}
	if s.Status == "stopped" && s.StoppedAt != "" {
		l3 += " · stopped " + ago(s.StoppedAt)
	}
	if s.Status == "shelved" && s.ShelvedAt != "" {
		l3 += " · shelved " + ago(s.ShelvedAt)
	}
	head = append(head, sDim.Render(truncate(l3, w)))
	if t := s.ErrorTitle(); t != "" && (s.Status == "failed" || s.Status == "stopped" || s.Status == "running") {
		head = append(head, sBad.Render("✖ "+truncate(t, w-2)))
	}
	var tabs []string
	for i, n := range tabNames {
		if detailTab(i) == m.detail {
			tabs = append(tabs, sSel.Render(" "+n+" "))
		} else {
			tabs = append(tabs, sDim.Render(" "+n+" "))
		}
	}
	head = append(head, strings.Join(tabs, ""))
	hh := len(head) + 1
	m.vp.Width, m.vp.Height = w, h-hh
	if m.vp.Height < 3 {
		m.vp.Height = 3
	}
	m.vp.SetContent(m.detailContent(s, w-1))
	return strings.Join(head, "\n") + "\n" + withMoreHint(m.vp)
}

func (m *model) detailContent(s *Machine, w int) string {
	switch m.detail {
	case tabMonitor:
		switch s.Status {
		case "running":
			if m.teleErr[s.ID] != "" {
				return sWarn.Render("Couldn't read telemetry: " + m.teleErr[s.ID])
			}
			return renderMonitor(m.tele[s.ID], w, false, teleRanges[m.rangeIx].label)
		case "stopped":
			return sDim.Render("Stopped. Press s to start it. The disk is still billed.")
		case "shelved":
			return sDim.Render("Shelved: only the snapshot is billed. Press r to restore it with your games.")
		case "failed":
			return sBad.Render("This machine failed to start.") + "\n" + sDim.Render("See the Activity tab for what happened, then press D to delete it or y to refresh.")
		}
		if c := m.conn[s.ID]; c != nil {
			return m.setupView(c, w)
		}
		return m.spin.View() + sDim.Render(" "+s.Status+"…")
	case tabConnect:
		return m.connectView(s, w)
	case tabInfo:
		return m.infoView(s, w)
	default:
		return m.machineOpsView(s, w)
	}
}

func (m *model) setupView(c *Connection, w int) string {
	if len(c.Setup.Stages) == 0 {
		return sDim.Render("No setup progress yet.")
	}
	var b strings.Builder
	cur := c.Setup.Stages[len(c.Setup.Stages)-1]
	b.WriteString(sAccent.Render("ON-MACHINE SETUP") + "  " + bar(cur.Percent, 100, 24, sWarn) + fmt.Sprintf(" %.0f%%\n", cur.Percent))
	b.WriteString(sText.Render(cur.Message) + "\n")
	if cur.Detail != "" {
		b.WriteString(sDim.Render(strings.Join(wrap(cur.Detail, w), "\n")) + "\n")
	}
	if c.Setup.Stale {
		b.WriteString(sWarn.Render("▲ last seen: the machine isn't answering right now") + "\n")
	}
	if c.Setup.Stuck {
		b.WriteString(sWarn.Render("▲ the setup looks stalled: press R to resume it") + "\n")
	}
	if c.Setup.StopReason != "" {
		b.WriteString(sWarn.Render("▲ "+c.Setup.StopReason) + "\n")
	}
	b.WriteString("\n" + sDim.Render("Stages:") + "\n")
	from := 0
	if len(c.Setup.Stages) > 10 {
		from = len(c.Setup.Stages) - 10
	}
	for _, st := range c.Setup.Stages[from:] {
		b.WriteString(sDim.Render(fmt.Sprintf("%3.0f%% ", st.Percent)) + truncate(st.Message, w-6) + "\n")
	}
	return b.String()
}

func (m *model) connectView(s *Machine, w int) string {
	c := m.conn[s.ID]
	if c == nil {
		if s.Status == "running" || s.Busy() {
			return m.spin.View() + sDim.Render(" reading connection details…")
		}
		return sDim.Render("Connection details appear while the machine is running.")
	}
	var b strings.Builder
	if c.Setup.Ready {
		b.WriteString(sGood.Render("✓ Ready to stream") + sDim.Render(": open Moonlight and add this machine's IP.") + "\n\n")
	}
	row := func(k, v string) { b.WriteString(sDim.Render(pad(k, 16)) + v + "\n") }
	if c.IP != "" {
		row("Moonlight host", sBold.Render(c.IP)+sDim.Render("   (C copies)"))
	}
	if c.Username != "" {
		row("Sunshine login", c.Username)
		pw := strings.Repeat("•", 10)
		if m.showPass {
			pw = c.Password
		}
		row("Password", pw+sDim.Render("   (v shows · c copies)"))
	}
	if c.SunshineURL != "" {
		row("Sunshine admin", c.SunshineURL+sDim.Render("   (o opens)"))
	}
	if c.Browser.Desktop.URL != "" {
		a := sDim.Render("not answering yet")
		if c.Browser.Desktop.Available {
			a = sGood.Render("available")
		}
		row("Desktop in browser", truncate(c.Browser.Desktop.URL, w-30)+" "+a)
	}
	if c.Browser.Play.URL != "" {
		a := sDim.Render("not answering yet")
		if c.Browser.Play.Available {
			a = sGood.Render("available")
		}
		row("Play in browser", truncate(c.Browser.Play.URL, w-30)+" "+a)
	}
	b.WriteString("\n" + sDim.Render("Press p to pair Moonlight (GGGH picks a PIN and types it into Sunshine for you).") + "\n\n")
	b.WriteString(m.setupView(c, w))
	return b.String()
}

func (m *model) infoView(s *Machine, w int) string {
	var b strings.Builder
	row := func(k, v string) {
		if v != "" {
			b.WriteString(sDim.Render(pad(k, 18)) + v + "\n")
		}
	}
	row("Cloud", providerLabel(s.Provider))
	row("Region", s.Region)
	row("Size", s.InstanceType)
	row("Pricing", map[bool]string{true: "spot", false: "on-demand"}[s.Spot]+sDim.Render("   ($ switches)"))
	row("Cost while running", money(s.CostPerHour)+"/hour")
	if s.Standing != nil {
		row("Disk", fmt.Sprintf("%.0f GB · %s/month, billed even when stopped", s.Standing.DiskGb, money(s.Standing.DiskMonthly)))
		if s.Standing.ShelfMonthly != nil {
			row("Shelved snapshot", money(*s.Standing.ShelfMonthly)+"/month")
		}
	}
	row("Quality", s.Quality)
	if s.AutoStopMin != nil {
		if *s.AutoStopMin == 0 {
			row("Auto-stop", "off")
		} else {
			row("Auto-stop", fmt.Sprintf("after %.0f idle minutes", *s.AutoStopMin))
		}
	}
	if s.AutoShelveDays != nil && *s.AutoShelveDays > 0 {
		row("Auto-shelve", fmt.Sprintf("after %.0f days stopped", *s.AutoShelveDays))
	}
	row("Game", s.GameTitle)
	row("Created", s.CreatedAt+sDim.Render("  ("+ago(s.CreatedAt)+")"))
	row("Machine id", s.ID)
	if len(s.Addons) > 0 {
		var ids []string
		for _, a := range s.Addons {
			ids = append(ids, a.ID)
		}
		row("Extra tools", strings.Join(ids, ", ")+sDim.Render("  (log on the machine: /var/log/cg-addons.log)"))
	}
	if t := s.ErrorTitle(); t != "" {
		row("Last error", sBad.Render(t))
	}
	return b.String()
}

func opGlyph(status string) (string, lipgloss.Style) {
	switch status {
	case "succeeded":
		return "✓", sGood
	case "failed":
		return "✖", sBad
	case "running":
		return "◐", sWarn
	}
	return "·", sDim
}

func opRow(o OpSummary, selected bool, w int) string {
	g, st := opGlyph(o.Status)
	line := st.Render(g) + " " + sDim.Render(pad(ago(o.CreatedAt), 14)) + truncate(o.Title, w-20)
	if selected {
		return sKey.Render("▸ ") + sBold.Render(line)
	}
	return "  " + line
}

func (m *model) machineOpsView(s *Machine, w int) string {
	ops := m.mops[s.ID]
	if ops == nil {
		return m.spin.View() + sDim.Render(" loading activity…")
	}
	if len(ops) == 0 {
		return sDim.Render("No activity for this machine yet.")
	}
	var b strings.Builder
	for _, o := range ops {
		b.WriteString(opRow(o, false, w) + "\n")
		if o.LastMessage != "" {
			b.WriteString("      " + sDim.Render(truncate(o.LastMessage, w-8)) + "\n")
		}
	}
	b.WriteString("\n" + sDim.Render("Open the Activity screen (2) for full logs."))
	return b.String()
}

// ---- activity ---------------------------------------------------------------------------------

func (m *model) activityView(w, h int) string {
	if m.opv != nil {
		return m.opViewView(w, h)
	}
	if len(m.ops) == 0 {
		return sDim.Render(strings.Join(wrap("No activity yet. Launching, starting and stopping machines shows up here, step by step.", w), "\n"))
	}
	var rows []string
	for i, o := range m.ops {
		row := opRow(o, i == m.opSel, w-2)
		if o.LastMessage != "" {
			row += "\n      " + sDim.Render(truncate(o.LastMessage, w-8))
		}
		rows = append(rows, row)
	}
	// keep the selection on screen
	per := 2
	visible := h / per
	if visible < 1 {
		visible = 1
	}
	start := 0
	if m.opSel >= visible {
		start = m.opSel - visible + 1
	}
	end := start + visible
	if end > len(rows) {
		end = len(rows)
	}
	return sAccent.Render("ACTIVITY") + sDim.Render(fmt.Sprintf("  (%d)", len(m.ops))) + "\n" + strings.Join(rows[start:end], "\n")
}

func (m *model) opViewView(w, h int) string {
	o := m.opv
	g, st := opGlyph(o.status)
	head := st.Render(g+" "+o.status) + "  " + sBold.Render(o.title)
	if !o.done && o.status != "" {
		head += " " + m.spin.View()
	}
	var lines []string
	for _, e := range o.events {
		ts := ""
		if t, err := time.Parse(time.RFC3339, e.At); err == nil {
			ts = t.Local().Format("15:04:05")
		}
		lv := sDim
		glyph := "·"
		switch e.Level {
		case "success":
			lv, glyph = sGood, "✓"
		case "error":
			lv, glyph = sBad, "✖"
		case "warn", "warning":
			lv, glyph = sWarn, "▲"
		}
		msg := e.Message
		if e.Detail != "" {
			msg += " — " + e.Detail
		}
		wr := wrap(msg, w-14)
		for i, l := range wr {
			if i == 0 {
				lines = append(lines, sDim.Render(ts)+" "+lv.Render(glyph)+" "+l)
			} else {
				lines = append(lines, "           "+l)
			}
		}
	}
	if o.errText != "" {
		lines = append(lines, "", sBad.Render("✖ "+o.errText))
	}
	if len(lines) == 0 {
		lines = []string{sDim.Render("waiting for the first message…")}
	}
	atBottom := o.vp.AtBottom()
	o.vp.Width, o.vp.Height = w, h-2
	o.vp.SetContent(strings.Join(lines, "\n"))
	if atBottom {
		o.vp.GotoBottom()
	}
	return head + "\n" + sDim.Render(strings.Repeat("─", w)) + "\n" + o.vp.View()
}

// ---- local PCs ------------------------------------------------------------------------------------

func (m *model) localView(w, h int) string {
	if len(m.local) == 0 {
		return sDim.Render(strings.Join(wrap("No local PCs yet.\n\nA local PC is a gaming computer at home that you stream from. Add one in the web app (Machines → Your own PCs) and it reports here.", w), "\n"))
	}
	listW := 34
	var l strings.Builder
	l.WriteString(sAccent.Render(fmt.Sprintf("YOUR OWN PCS (%d)", len(m.local))) + "\n")
	for i, p := range m.local {
		dot, st := "● online", sGood
		if !p.Online {
			dot, st = "○ offline", sDim
		}
		name := truncate(p.Name, listW-6)
		if i == m.lsel {
			l.WriteString(sKey.Render("▸ ") + sBold.Render(name) + "\n  " + st.Render(dot) + "\n")
		} else {
			l.WriteString("  " + sText.Render(name) + "\n  " + st.Render(dot) + "\n")
		}
	}
	p := m.local[m.lsel]
	var d strings.Builder
	d.WriteString(sBold.Render(p.Name) + "\n")
	info := []string{}
	if p.LanIP != "" {
		info = append(info, "LAN "+p.LanIP)
	}
	if v, ok := p.Status["sunshine"].(string); ok {
		info = append(info, "Sunshine "+strings.ToLower(v))
	}
	if v, ok := p.Status["link"].(string); ok {
		wired := "wired"
		if wv, ok := p.Status["wired"].(bool); ok && !wv {
			wired = "Wi-Fi"
		}
		info = append(info, wired+" "+v)
	}
	if p.LastSeenAt != "" {
		info = append(info, "seen "+ago(p.LastSeenAt))
	}
	d.WriteString(sDim.Render(strings.Join(info, " · ")) + "\n\n")
	if w < 100 {
		d.WriteString(renderMonitor(m.localTele[p.ID], w-1, true, teleRanges[m.rangeIx].label))
		m.lvp.Width, m.lvp.Height = w, h-len(m.local)*2-2
		if m.lvp.Height < 3 {
			m.lvp.Height = 3
		}
		m.lvp.SetContent(d.String())
		return l.String() + "\n" + withMoreHint(m.lvp)
	}
	d.WriteString(renderMonitor(m.localTele[p.ID], w-listW-4, true, teleRanges[m.rangeIx].label))
	m.lvp.Width, m.lvp.Height = w-listW-2, h
	m.lvp.SetContent(d.String())
	return lipgloss.JoinHorizontal(lipgloss.Top, sBox.Width(listW-2).Height(h-2).Render(strings.TrimRight(l.String(), "\n")), " ", withMoreHint(m.lvp))
}

// ---- prompts and help ------------------------------------------------------------------------------

func (m *model) promptView() string {
	p := m.prompt
	st := sBox
	if p.danger {
		st = sBoxWarn
	}
	var b strings.Builder
	title := sBold.Render(p.title)
	if p.danger {
		title = sBad.Render("▲ ") + title
	}
	b.WriteString(title + "\n\n")
	if p.body != "" {
		b.WriteString(strings.Join(wrap(p.body, 62), "\n") + "\n\n")
	}
	switch p.kind {
	case pConfirm:
		b.WriteString(sKey.Render("y") + " yes   " + sKey.Render("n") + " no")
	case pInput:
		b.WriteString(p.ti.View() + "\n\n" + sKey.Render("enter") + " save   " + sKey.Render("esc") + " cancel")
	default:
		b.WriteString(sKey.Render("enter") + " close")
	}
	return st.Padding(1, 3).Render(b.String())
}

func (m *model) helpView() string {
	rows := [][2]string{
		{"1 2 3", "Machines · Activity · Local PCs"},
		{"n", "launch a new machine (what is it for? → size → tools)"},
		{"↑ ↓  j k", "choose a machine"},
		{"← →  tab", "Monitor · Connect · Info · Activity tabs"},
		{"w", "monitor window: 15 min · 1 h · 6 h · 24 h"},
		{"s / x", "start a stopped machine / stop a running one"},
		{"z", "shelve (snapshot, then delete the machine: cheap)"},
		{"r", "restore a shelved machine · otherwise refresh"},
		{"p", "pair Moonlight (shows the PIN command)"},
		{"u / U", "update the on-machine script / and restart"},
		{"R", "resume an unfinished setup"},
		{"e", "rename"},
		{"$", "switch spot ⇄ on-demand"},
		{"D", "delete a machine (asks first)"},
		{"c / C / v / o", "copy password / copy IP / show password / open Sunshine"},
		{"J K  pgup pgdn", "scroll the detail pane"},
		{"ctrl+r", "refresh everything now"},
		{"L", "sign out"},
		{"q", "quit"},
	}
	var b strings.Builder
	b.WriteString(sTitle.Render("KEYS") + "\n\n")
	for _, r := range rows {
		b.WriteString(sKey.Render(pad(r[0], 16)) + r[1] + "\n")
	}
	b.WriteString("\n" + sDim.Render("any key closes"))
	return sBox.Padding(1, 3).Render(b.String())
}

// withMoreHint draws the viewport, replacing its last line with a hint while there is more below.
func withMoreHint(vp viewport.Model) string {
	v := vp.View()
	if vp.AtBottom() {
		return v
	}
	lines := strings.Split(v, "\n")
	if len(lines) > 0 {
		lines[len(lines)-1] = sDim.Render("▼ more below: J / K or pgdn / pgup to scroll")
	}
	return strings.Join(lines, "\n")
}
