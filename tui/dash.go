package main

import (
	"fmt"
	"sort"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

func truncateAnsi(s string, w int) string { return ansi.Truncate(s, w, "") }

// Dashboard and Performance mirror the web app's pages of the same names:
// Dashboard = what is on, what it costs and what needs attention;
// Performance = one card per machine (cloud and your own PCs together) with live numbers.

// ---- data ----------------------------------------------------------------------------------

type invMsg struct {
	inv *Inventory
	err error
}

func (m *model) cmdInv() tea.Cmd {
	be := m.be
	return func() tea.Msg {
		i, err := be.Inventory(false)
		return invMsg{i, err}
	}
}

// vit: the latest readings of one machine, in the few numbers the Dashboard and Performance show.
type vit struct {
	ok                 bool
	gpu, cpu           float64
	hasGPU, hasCPU     bool
	ramU, ramT         float64
	vramU, vramT       float64
	fps                float64
	hasFPS             bool
	rtt                float64
	hasRTT             bool
	netIn, netOut      float64
	hasNet             bool
	diskPct            float64
	hasDisk            bool
	streaming          bool
	upSec              float64
	hasUp              bool
	readAgo            string
	gpuTrend, cpuTrend []float64
	alerts             []Alert
}

func vitalsOf(t *Telemetry) vit {
	var v vit
	if t == nil || t.Latest == nil {
		return v
	}
	s := t.Latest
	v.ok = true
	v.alerts = t.Alerts
	if u, ok := s.gnum("u"); ok {
		v.gpu, v.hasGPU = u, true
	}
	if s.C != nil {
		v.cpu, v.hasCPU = *s.C, true
	}
	if len(s.M) == 2 {
		v.ramU, v.ramT = s.M[0], s.M[1]
	}
	if vt, ok := s.gnum("vt"); ok && vt > 0 {
		vu, _ := s.gnum("vu")
		v.vramU, v.vramT = vu/1024, vt/1024
	}
	es, _ := s.gnum("es")
	v.streaming = es > 0
	if s.GF != nil && s.GF.F != nil {
		v.fps, v.hasFPS = *s.GF.F, true
	} else if ef, ok := s.gnum("ef"); ok && es > 0 {
		v.fps, v.hasFPS = ef, true
	}
	if s.RT != nil && s.RT.R != nil {
		v.rtt, v.hasRTT = *s.RT.R, true
	}
	if s.NI != nil || s.NO != nil {
		v.netIn, v.netOut, v.hasNet = derefF(s.NI), derefF(s.NO), true
	}
	if len(s.D) == 2 && s.D[1] > 0 {
		v.diskPct, v.hasDisk = s.D[0]/s.D[1]*100, true
	}
	if s.UP != nil {
		v.upSec, v.hasUp = *s.UP, true
	}
	v.gpuTrend = series(t.Samples, func(x *Sample) (float64, bool) { return x.gnum("u") })
	v.cpuTrend = series(t.Samples, func(x *Sample) (float64, bool) {
		if x.C == nil {
			return 0, false
		}
		return *x.C, true
	})
	return v
}

// perfEntry: one machine on Performance or one row of the Dashboard's active table.
type perfEntry struct {
	cloud *Machine
	local *LocalMachine
}

func (e perfEntry) id() string {
	if e.cloud != nil {
		return e.cloud.ID
	}
	return e.local.ID
}

func (e perfEntry) on() bool {
	if e.cloud != nil {
		return e.cloud.Status == "running"
	}
	return e.local.Online
}

func (m *model) vitalsFor(e perfEntry) vit {
	if e.cloud != nil {
		return vitalsOf(m.tele[e.cloud.ID])
	}
	return vitalsOf(m.localTele[e.local.ID])
}

// perfEntries: every machine that is a real machine (failed launches never were), in list order:
// running first, then the rest; your own PCs after the cloud ones.
func (m *model) perfEntries() []perfEntry {
	var out []perfEntry
	for i := range m.allMachines {
		x := &m.allMachines[i]
		if x.Status == "failed" || x.Status == "missing" {
			continue
		}
		out = append(out, perfEntry{cloud: x})
	}
	for i := range m.local {
		out = append(out, perfEntry{local: &m.local[i]})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].on() && !out[j].on() }) // what is on comes first
	return out
}

func (e perfEntry) name() string {
	if e.cloud != nil {
		return e.cloud.Name()
	}
	return e.local.Name
}

func (e perfEntry) where() string {
	if e.cloud != nil {
		w := providerLabel(e.cloud.Provider) + " · " + e.cloud.Region
		if e.cloud.Spot {
			w += " · spot"
		}
		return w
	}
	w := "Local PC"
	if e.local.LanIP != "" {
		w += " · " + e.local.LanIP
	}
	if wv, ok := e.local.Status["wired"].(bool); ok {
		if wv {
			w += " · wired"
		} else {
			w += " · Wi-Fi"
		}
	}
	return w
}

func (e perfEntry) pill() string {
	if e.cloud != nil {
		return statusPill(e.cloud.Status)
	}
	if e.local.Online {
		return pill("● ONLINE", gGreen)
	}
	return pill("○ OFFLINE", rgb{125, 135, 150})
}

func (e perfEntry) perHour() float64 {
	if e.cloud != nil && e.cloud.Status == "running" {
		return e.cloud.CostPerHour
	}
	return 0
}

// ---- keys ------------------------------------------------------------------------------------

func (m *model) dashKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch k.String() {
	case "up", "k":
		m.dvp.LineUp(1)
	case "down", "j":
		m.dvp.LineDown(1)
	case "pgup", "ctrl+u", "K":
		m.dvp.HalfViewUp()
	case "pgdown", "ctrl+d", "J":
		m.dvp.HalfViewDown()
	case "home", "g":
		m.dvp.GotoTop()
	case "r":
		m.refreshNow()
	}
	return m, nil
}

func (m *model) perfKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	es := m.perfEntries()
	switch k.String() {
	case "up", "k":
		if m.psel > 0 {
			m.psel--
		}
	case "down", "j":
		if m.psel < len(es)-1 {
			m.psel++
		}
	case "pgup", "ctrl+u", "K":
		m.pvp.HalfViewUp()
	case "pgdown", "ctrl+d", "J":
		m.pvp.HalfViewDown()
	case "home", "g":
		m.psel = 0
	case "w":
		m.rangeIx = (m.rangeIx + 1) % len(teleRanges)
		m.last = dropKeys(m.last, "tele:")
		m.setNotice("Window: "+teleRanges[m.rangeIx].label, false)
	case "r":
		m.refreshNow()
	case "enter", "m":
		if m.psel < len(es) {
			e := es[m.psel]
			m.showFailed = false
			m.applyMachineFilter()
			if e.cloud != nil {
				for i := range m.machines {
					if m.machines[i].ID == e.cloud.ID {
						m.sel = i
					}
				}
			} else {
				for i := range m.local {
					if m.local[i].ID == e.local.ID {
						m.sel = len(m.machines) + i
					}
				}
			}
			m.detail = tabMonitor
			m.vp.GotoTop()
			m.screen = scrMachines
		}
	}
	return m, nil
}

// ---- small pieces ---------------------------------------------------------------------------------

// labelled gauge: "GPU  ████████░░  73%" in `w` columns.
func labelBar(label string, v, max float64, w int, tail string) string {
	barW := w - 5 - lipgloss.Width(tail) - 2
	if barW < 4 {
		barW = 4
	}
	vv := v
	if max <= 0 {
		vv = 0
	}
	return sDim.Render(pad(label, 5)) + gauge(vv, max, barW) + " " + lipgloss.NewStyle().Foreground(loadRGB(frac(v, max)).color()).Render(tail)
}

func frac(v, max float64) float64 {
	if max <= 0 {
		return 0
	}
	return v / max
}

func pctTail(v float64) string { return pad(fmt.Sprintf("%.0f%%", v), 4) }

func gb(v float64) string { return fmt.Sprintf("%.1f", v) }

// ---- Performance --------------------------------------------------------------------------------------

func (m *model) perfCard(e perfEntry, selected bool, w int) string {
	iw := w - 4
	v := m.vitalsFor(e)
	title := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#ffffff")).Render(truncate(e.name(), iw-26)) + "  " + e.pill()
	if e.cloud != nil && e.cloud.Busy() {
		title += " " + m.spin.View()
	}
	if c := e.perHour(); c > 0 {
		title += sDim.Render("  " + money(c) + "/h")
	}
	sub := e.where()
	if e.cloud != nil && e.cloud.Status == "running" && e.cloud.LastStarted != "" {
		sub += " · up " + strings.TrimSuffix(ago(e.cloud.LastStarted), " ago")
	} else if v.hasUp {
		sub += " · up " + upFor(v.upSec)
	}
	lines := []string{title, sDim.Render(truncate(sub, iw))}

	switch {
	case !e.on():
		msg := "Not running: no live readings."
		if e.cloud != nil {
			switch e.cloud.Status {
			case "stopped":
				msg = "Stopped: only the disk is billed. s on the Machines screen starts it."
			case "shelved":
				msg = "Shelved: only the snapshot is billed."
			case "creating", "starting", "restoring":
				msg = "Setting up: readings start once it is running."
			}
		} else {
			msg = "Offline: the GGGH agent on this PC is not reporting."
		}
		lines = append(lines, sDim.Render(truncate(msg, iw)))
	case !v.ok:
		lines = append(lines, m.spin.View()+sDim.Render(" reading telemetry…"))
	default:
		colW := iw
		two := iw >= 72
		if two {
			colW = (iw - 3) / 2
		}
		var left, right []string
		if v.hasGPU {
			left = append(left, labelBar("GPU", v.gpu, 100, colW, pctTail(v.gpu)))
		}
		if v.vramT > 0 {
			right = append(right, labelBar("VRAM", v.vramU, v.vramT, colW, fmt.Sprintf("%s/%.0f GB", gb(v.vramU), v.vramT)))
		}
		if v.hasCPU {
			left = append(left, labelBar("CPU", v.cpu, 100, colW, pctTail(v.cpu)))
		}
		if v.ramT > 0 {
			right = append(right, labelBar("RAM", v.ramU, v.ramT, colW, fmt.Sprintf("%s/%.0f GB", gb(v.ramU), v.ramT)))
		}
		if two {
			for len(left) < len(right) {
				left = append(left, "")
			}
			for len(right) < len(left) {
				right = append(right, "")
			}
			for i := range left {
				lines = append(lines, pad(left[i], colW)+"   "+right[i])
			}
		} else {
			lines = append(lines, left...)
			lines = append(lines, right...)
		}
		var facts []string
		switch {
		case v.hasFPS:
			facts = append(facts, "FPS "+sText.Render(f0(v.fps)))
		case v.streaming:
			facts = append(facts, "streaming")
		default:
			facts = append(facts, "not streaming")
		}
		if v.hasRTT {
			facts = append(facts, "RTT "+sText.Render(f0(v.rtt)+" ms"))
		}
		if v.hasNet {
			facts = append(facts, "net "+sText.Render(fmt.Sprintf("↓%.0f ↑%.0f Mbit/s", v.netIn, v.netOut)))
		}
		if v.hasDisk {
			facts = append(facts, "disk "+sText.Render(f0(v.diskPct)+"%"))
		}
		var bits []string
		for i, f := range facts {
			if i == 0 {
				bits = append(bits, sDim.Render(f))
			} else {
				bits = append(bits, sDim.Render(f))
			}
		}
		lines = append(lines, truncate(strings.Join(bits, sDim.Render("  ·  ")), iw))
		sw := (iw - 2) / 2
		if sw >= 16 {
			g := sDim.Render("GPU ") + sparkColor(v.gpuTrend, sw-4, 100, true)
			c := sDim.Render("CPU ") + sparkColor(v.cpuTrend, sw-4, 100, true)
			lines = append(lines, g+"  "+c)
		}
		if len(v.alerts) == 0 {
			lines = append(lines, sGood.Render("✓")+sDim.Render(" no alerts"))
		}
		for i, a := range v.alerts {
			if i >= 2 {
				lines = append(lines, sDim.Render(fmt.Sprintf("+%d more alerts: open the Monitor tab", len(v.alerts)-2)))
				break
			}
			lines = append(lines, firstLine(alertLine(a, iw)))
		}
	}
	border := lipgloss.AdaptiveColor{Light: "#b8c4d0", Dark: "#2f3b4a"}
	st := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).Padding(0, 1).Width(w - 2)
	if selected {
		st = st.BorderForeground(gCyan.color())
	} else {
		st = st.BorderForeground(border)
	}
	return st.Render(strings.Join(lines, "\n"))
}

func firstLine(s string) string {
	if i := strings.Index(s, "\n"); i >= 0 {
		return s[:i]
	}
	return s
}

func (m *model) perfCardsView(w, h int) string {
	if !m.loaded {
		return m.spin.View() + " loading your machines…"
	}
	es := m.perfEntries()
	if len(es) == 0 {
		return sDim.Render(strings.Join(wrap("No machines yet. Press n to launch one: it shows here with live GPU, CPU, memory and network readings.", w), "\n"))
	}
	if m.psel >= len(es) {
		m.psel = len(es) - 1
	}
	running, hourly, localOn := 0, 0.0, 0
	for _, e := range es {
		if e.cloud != nil && e.cloud.Status == "running" {
			running++
			hourly += e.cloud.CostPerHour
		}
		if e.local != nil && e.local.Online {
			localOn++
		}
	}
	head := sectionTitle("PERFORMANCE") + sDim.Render(fmt.Sprintf("  %d machine%s · %d running · ≈%s/hour right now", len(es), plural(len(es)), running, money(hourly)))
	if len(m.local) > 0 {
		head += sDim.Render(fmt.Sprintf(" · %d of %d local PC%s online", localOn, len(m.local), plural(len(m.local))))
	}
	head += sDim.Render("  · window " + teleRanges[m.rangeIx].label)

	var cards []string
	var starts []int
	line := 0
	for i, e := range es {
		c := m.perfCard(e, i == m.psel, w-1)
		cards = append(cards, c)
		starts = append(starts, line)
		line += lipgloss.Height(c)
	}
	m.pvp.Width, m.pvp.Height = w, h-2
	if m.pvp.Height < 4 {
		m.pvp.Height = 4
	}
	m.pvp.SetContent(strings.Join(cards, "\n"))
	// keep the selected card in view
	top, bot := starts[m.psel], starts[m.psel]+lipgloss.Height(cards[m.psel])
	switch {
	case top < m.pvp.YOffset:
		m.pvp.SetYOffset(top)
	case bot > m.pvp.YOffset+m.pvp.Height:
		m.pvp.SetYOffset(bot - m.pvp.Height)
	}
	return head + "\n" + sDim.Render(strings.Repeat("─", w)) + "\n" + withMoreHint(m.pvp)
}

// ---- Dashboard ----------------------------------------------------------------------------------------

func (m *model) dashboardView(w, h int) string {
	if !m.loaded {
		return m.spin.View() + " loading…"
	}
	m.dvp.Width, m.dvp.Height = w, h
	m.dvp.SetContent(m.dashContent(w - 1))
	return withMoreHint(m.dvp)
}

func (m *model) dashContent(w int) string {
	es := m.perfEntries()
	var on []perfEntry
	var stopped, shelved, busy int
	hourly := 0.0
	localOn := 0
	for _, e := range es {
		if e.on() {
			on = append(on, e)
			hourly += e.perHour()
			if e.local != nil {
				localOn++
			}
			continue
		}
		if e.cloud != nil {
			switch {
			case e.cloud.Busy():
				busy++
			case e.cloud.Status == "shelved":
				shelved++
			default:
				stopped++
			}
		}
	}
	cols := 4
	if w < 90 {
		cols = 2
	}

	// ---- money tiles
	run := tile{title: "Running now", compact: true, value: money(hourly) + "/h", sub: fmt.Sprintf("%d cloud · %d local PC%s on", len(on)-localOn, localOn, plural(localOn))}
	if hourly == 0 {
		run.sub = "nothing is billing compute"
	}
	month := tile{title: "This month", compact: true, value: "—", sub: "estimated so far"}
	if sp := m.spend; sp != nil {
		month.value = money(sp.MonthToDate.Usd)
		month.sub = "today " + money(sp.Today.Usd)
		if sp.ProjectedMonthUsd > 0 {
			month.sub = "of ≈" + money(sp.ProjectedMonthUsd) + " projected"
			month.gaugeVal, month.gaugeMax = sp.MonthToDate.Usd, sp.ProjectedMonthUsd
		}
	}
	stand := tile{title: "Standing cost", compact: true, value: "—", sub: "disks & snapshots, billed even when stopped"}
	left := tile{title: "Leftovers", compact: true, value: "—", sub: "orphaned resources"}
	if iv := m.inv; iv != nil {
		stand.value = money(iv.Totals.MonthlyStanding) + "/mo"
		left.value = fmt.Sprintf("%d", iv.Totals.Orphans)
		left.sub = "nothing orphaned"
		if iv.Totals.Orphans > 0 {
			left.tone, left.sub = "warn", fmt.Sprintf("≈%s/mo wasted: see Costs", money(iv.Totals.OrphanMonthly))
		}
	}
	out := []string{sectionTitle("MONEY"), grid([]tile{run, month, stand, left}, w, cols)}

	// ---- fleet performance tiles (averages across everything that is on)
	var gSum, cSum, mU, mT, no, ni float64
	var gN, cN, streaming int
	for _, e := range on {
		v := m.vitalsFor(e)
		if !v.ok {
			continue
		}
		if v.hasGPU {
			gSum += v.gpu
			gN++
		}
		if v.hasCPU {
			cSum += v.cpu
			cN++
		}
		mU += v.ramU
		mT += v.ramT
		if v.hasNet {
			no += v.netOut
			ni += v.netIn
		}
		if v.streaming {
			streaming++
		}
	}
	gpuT := tile{title: "GPU load (avg)", compact: true, value: "—", sub: "no readings yet"}
	if gN > 0 {
		a := gSum / float64(gN)
		gpuT.value, gpuT.sub, gpuT.gaugeVal, gpuT.gaugeMax = f0(a)+"%", fmt.Sprintf("across %d machine%s", gN, plural(gN)), a, 100
	}
	cpuT := tile{title: "CPU load (avg)", compact: true, value: "—", sub: "no readings yet"}
	if cN > 0 {
		a := cSum / float64(cN)
		cpuT.value, cpuT.sub, cpuT.gaugeVal, cpuT.gaugeMax = f0(a)+"%", fmt.Sprintf("across %d machine%s", cN, plural(cN)), a, 100
	}
	ramT := tile{title: "Memory in use", compact: true, value: "—", sub: "no readings yet"}
	if mT > 0 {
		ramT.value, ramT.sub, ramT.gaugeVal, ramT.gaugeMax = fmt.Sprintf("%s / %.0f GB", gb(mU), mT), "all running machines", mU, mT
	}
	strT := tile{title: "Streaming now", compact: true, value: fmt.Sprintf("%d of %d", streaming, len(on)), sub: "Moonlight sessions"}
	if len(on) == 0 {
		strT.value, strT.sub = "0", "nothing running"
	} else if no > 0 {
		strT.sub = fmt.Sprintf("↑%.0f Mbit/s out · ↓%.0f in", no, ni)
	}
	out = append(out, "", sectionTitle("PERFORMANCE"), grid([]tile{gpuT, cpuT, ramT, strT}, w, cols))

	// ---- the machines that are on
	out = append(out, "", sectionTitle("ACTIVE MACHINES")+sDim.Render(fmt.Sprintf("  (%d)", len(on))))
	if len(on) == 0 {
		out = append(out, sDim.Render("Nothing is running. Press n to launch a machine, or 2 for the Machines list."))
	} else {
		out = append(out, m.activeTable(on, w))
	}
	var rest []string
	if stopped > 0 {
		rest = append(rest, fmt.Sprintf("%d stopped", stopped))
	}
	if shelved > 0 {
		rest = append(rest, fmt.Sprintf("%d shelved", shelved))
	}
	if busy > 0 {
		rest = append(rest, fmt.Sprintf("%d changing state", busy))
	}
	if m.failedCount > 0 {
		rest = append(rest, fmt.Sprintf("%d failed launch%s (hidden)", m.failedCount, map[bool]string{true: "", false: "es"}[m.failedCount == 1]))
	}
	if len(rest) > 0 {
		out = append(out, sDim.Render("Also: "+strings.Join(rest, " · ")))
	}

	// ---- attention + recent activity
	att := m.attentionLines(es, w)
	act := m.recentActivity(w)
	if w >= 110 {
		lw := w/2 - 1
		out = append(out, "", lipgloss.JoinHorizontal(lipgloss.Top,
			lipgloss.NewStyle().Width(lw).Render(m.attentionBlock(es, lw)), "  ",
			lipgloss.NewStyle().Width(w-lw-2).Render(m.activityBlock(w-lw-2))))
	} else {
		out = append(out, "", att, "", act)
	}
	return strings.Join(out, "\n")
}

func (m *model) attentionBlock(es []perfEntry, w int) string { return m.attentionLines(es, w) }
func (m *model) activityBlock(w int) string                  { return m.recentActivity(w) }

// activeTable: one line per machine that is on, with live bars.
func (m *model) activeTable(on []perfEntry, w int) string {
	nameW := 22
	if w < 100 {
		nameW = 16
	}
	barW := 8
	showMem := w >= 100
	hdr := sDim.Render(pad("MACHINE", nameW+2) + pad("WHERE", 14) + pad("UP", 8) + pad("$/H", 7) + pad("GPU", barW+6) + pad("CPU", barW+6))
	if showMem {
		hdr += sDim.Render(pad("RAM", 6) + pad("FPS", 6) + "RTT")
	}
	rows := []string{truncateAnsi(hdr, w)}
	for _, e := range on {
		v := m.vitalsFor(e)
		dot := sGood.Render("● ")
		for _, a := range v.alerts { // notes are information; only warnings and criticals flag the row
			if a.Level == "critical" {
				dot = sBad.Render("▲ ")
			} else if a.Level == "warning" && dot != sBad.Render("▲ ") {
				dot = sWarn.Render("▲ ")
			}
		}
		where := "local PC"
		up := "—"
		if e.cloud != nil {
			where = e.cloud.Provider + " " + shortRegion(e.cloud.Region)
			if e.cloud.LastStarted != "" {
				up = strings.TrimSuffix(strings.TrimSuffix(ago(e.cloud.LastStarted), " ago"), " min")
				up = strings.Replace(up, " min", "m", 1)
			}
		} else if v.hasUp {
			up = upFor(v.upSec)
		}
		cost := "—"
		if c := e.perHour(); c > 0 {
			cost = money(c)
		}
		cell := func(has bool, val float64) string {
			if !v.ok || !has {
				return sDim.Render(pad("—", barW+6))
			}
			return gauge(val, 100, barW) + " " + lipgloss.NewStyle().Foreground(loadRGB(val/100).color()).Render(pad(f0(val)+"%", 4))
		}
		row := dot + pad(truncate(e.name(), nameW), nameW) + sDim.Render(pad(truncate(where, 13), 14)) + sText.Render(pad(up, 8)) + sText.Render(pad(cost, 7)) + cell(v.hasGPU, v.gpu) + " " + cell(v.hasCPU, v.cpu)
		if showMem {
			ram, fps, rtt := "—", "—", "—"
			if v.ramT > 0 {
				ram = f0(v.ramU/v.ramT*100) + "%"
			}
			if v.hasFPS {
				fps = f0(v.fps)
			}
			if v.hasRTT {
				rtt = f0(v.rtt) + "ms"
			}
			row += " " + sText.Render(pad(ram, 6)+pad(fps, 6)+rtt)
		}
		rows = append(rows, truncateAnsi(row, w))
	}
	return strings.Join(rows, "\n")
}

func shortRegion(r string) string {
	if len(r) > 10 {
		return r[:10]
	}
	return r
}

// attentionLines: alerts from every running machine, plus failed launches, leftovers and cloud read errors.
func (m *model) attentionLines(es []perfEntry, w int) string {
	var lines []string
	for _, e := range es {
		if !e.on() {
			continue
		}
		for _, a := range m.vitalsFor(e).alerts {
			if a.Level != "warning" && a.Level != "critical" {
				continue
			}
			lines = append(lines, truncateAnsi(sBold.Render(e.name()+": ")+firstLine(alertLine(a, w-len(e.name())-4)), w))
		}
	}
	if m.failedCount > 0 {
		lines = append(lines, sWarn.Render(fmt.Sprintf("▲ %d failed launch%s : press f on Machines to review and delete", m.failedCount, map[bool]string{true: "", false: "es"}[m.failedCount == 1])))
	}
	if iv := m.inv; iv != nil && iv.Totals.Orphans > 0 {
		lines = append(lines, sWarn.Render(fmt.Sprintf("▲ %d orphaned resource%s costing ≈%s/mo: see Costs (5)", iv.Totals.Orphans, plural(iv.Totals.Orphans), money(iv.Totals.OrphanMonthly))))
	}
	if m.status != nil {
		for k, s := range m.status.Providers {
			if !s.Connected {
				lines = append(lines, sWarn.Render("▲ "+strings.ToUpper(k)+" is not connected: add its keys in the web app Config"))
			}
		}
	}
	title := sectionTitle("NEEDS ATTENTION")
	if len(lines) == 0 {
		return title + "\n" + sGood.Render("✓ nothing needs attention")
	}
	for i := range lines {
		lines[i] = truncateAnsi(lines[i], w)
	}
	return title + sDim.Render(fmt.Sprintf("  (%d)", len(lines))) + "\n" + strings.Join(lines, "\n")
}

func (m *model) recentActivity(w int) string {
	title := sectionTitle("RECENT ACTIVITY")
	if len(m.ops) == 0 {
		return title + "\n" + sDim.Render("Nothing yet.")
	}
	var rows []string
	for i, o := range m.ops {
		if i >= 5 {
			break
		}
		rows = append(rows, truncateAnsi(opRow(o, false, w-2), w))
	}
	return title + sDim.Render("  (4 opens all)") + "\n" + strings.Join(rows, "\n")
}

// ---- Performance: verbose for what is on, one line for the rest --------------------------------------------

// inactiveLine: a machine that is not running, as one line.
func (m *model) inactiveLine(e perfEntry, selected bool, w int) string {
	bar := "  "
	name := sText.Render(pad(truncate(e.name(), 24), 25))
	if selected {
		bar = lipgloss.NewStyle().Foreground(gCyan.color()).Render("▌ ")
		name = sBold.Render(pad(truncate(e.name(), 24), 25))
	}
	return truncateAnsi(bar+name+e.pill()+sDim.Render("  "+e.where()), w)
}

// perfView gives the machines that are on as much of the screen as they can use, split evenly:
// one running machine gets nearly every reading, two get half each, and so on. Machines that are
// off shrink to a line each at the bottom. With too many running for that, it falls back to cards.
func (m *model) perfView(w, h int) string {
	if !m.loaded {
		return m.spin.View() + " loading your machines…"
	}
	es := m.perfEntries()
	if len(es) == 0 {
		return sDim.Render(strings.Join(wrap("No machines yet. Press n to launch one: it shows here with live GPU, CPU, memory and network readings.", w), "\n"))
	}
	if m.psel >= len(es) {
		m.psel = len(es) - 1
	}
	nA := 0
	for _, e := range es {
		if e.on() {
			nA++
		}
	}
	rest := es[nA:]

	// the lines under the active panels: one per machine that is off
	restCap := 5
	if nA == 0 {
		restCap = max(3, h-4)
	}
	var restLines []string
	if len(rest) > 0 {
		sel := m.psel - nA
		start := 0
		if sel >= restCap {
			start = sel - restCap + 1
		}
		for i := start; i < len(rest) && i < start+restCap; i++ {
			restLines = append(restLines, m.inactiveLine(rest[i], nA+i == m.psel, w))
		}
		if n := len(rest) - start - restCap; n > 0 {
			restLines = append(restLines, sDim.Render(fmt.Sprintf("  ▼ %d more", n)))
		}
		restLines = append([]string{sDim.Render(fmt.Sprintf("NOT RUNNING (%d)", len(rest)))}, restLines...)
	}
	restH := len(restLines)
	if restH > 0 && nA > 0 {
		restH++ // a blank line above
	}

	head := sectionTitle("PERFORMANCE") + sDim.Render(fmt.Sprintf("  %d running · ≈%s/hour right now · window %s", nA, money(m.hourlyNow()), teleRanges[m.rangeIx].label))
	if nA > 0 && w >= 120 {
		head += sDim.Render("  · enter opens a machine for everything else")
	}
	avail := h - 2 - restH
	if nA > 0 {
		per := avail / nA
		if budget := per - 4; budget >= 8 {
			var panels []string
			for i := 0; i < nA; i++ {
				bg := budget
				if i < avail%nA { // spread the spare lines
					bg++
				}
				panels = append(panels, m.perfPanel(es[i], i == m.psel, w, bg))
			}
			body := strings.Join(panels, "\n")
			if restH > 0 {
				body += "\n\n" + strings.Join(restLines, "\n")
			}
			return head + "\n" + sDim.Render(strings.Repeat("─", w)) + "\n" + body
		}
		return m.perfCardsView(w, h) // too many on to show each one at length
	}
	return head + "\n" + sDim.Render(strings.Repeat("─", w)) + "\n" + sDim.Render("Nothing is running. Press n to launch a machine, or 2 to start one.") + "\n\n" + strings.Join(restLines, "\n")
}

func (m *model) hourlyNow() float64 {
	t := 0.0
	for _, e := range m.perfEntries() {
		t += e.perHour()
	}
	return t
}

// perfPanel: a running machine with as many readings as `budget` lines allow.
func (m *model) perfPanel(e perfEntry, selected bool, w, budget int) string {
	iw := w - 4
	title := lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#ffffff")).Render(truncate(e.name(), iw-24)) + "  " + e.pill()
	if c := e.perHour(); c > 0 {
		title += sDim.Render("  " + money(c) + "/h")
	}
	sub := e.where()
	if e.cloud != nil && e.cloud.LastStarted != "" {
		sub += " · up " + strings.TrimSuffix(ago(e.cloud.LastStarted), " ago")
	} else if v := m.vitalsFor(e); v.hasUp {
		sub += " · up " + upFor(v.upSec)
	}
	var tele *Telemetry
	if e.cloud != nil {
		tele = m.tele[e.cloud.ID]
	} else {
		tele = m.localTele[e.local.ID]
	}
	body := m.spin.View() + sDim.Render(" reading telemetry…")
	if tele != nil {
		body = renderMonitorFit(tele, iw-1, e.local != nil, teleRanges[m.rangeIx].label, budget)
	}
	st := lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).Padding(0, 1).Width(w - 2)
	if selected {
		st = st.BorderForeground(gCyan.color())
	} else {
		st = st.BorderForeground(lipgloss.AdaptiveColor{Light: "#b8c4d0", Dark: "#2f3b4a"})
	}
	return st.Render(title + "\n" + sDim.Render(truncate(sub, iw)) + "\n" + body)
}
