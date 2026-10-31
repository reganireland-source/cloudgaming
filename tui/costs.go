package main

import (
	"fmt"
	tea "github.com/charmbracelet/bubbletea"
	"math"
	"sort"
	"strings"
	"sync"

	"github.com/charmbracelet/lipgloss"
)

// costsData is everything the Costs page shows. Each part loads on its own, so a slow or broken
// one (a cloud's live bill, say) never blanks the rest; what failed is in Errs.
type costsData struct {
	Spend    *Spend
	Daily    []CostDay
	Monthly  *CostsMonthly
	Recon    *Recon
	Inv      *Inventory
	Invoices []CloudInvoices
	Errs     map[string]string
}

type costsMsg struct{ d *costsData }

func (m *model) cmdCosts(refresh bool) tea.Cmd {
	be := m.be
	return func() tea.Msg {
		d := &costsData{Errs: map[string]string{}}
		var mu sync.Mutex
		var wg sync.WaitGroup
		run := func(name string, f func() error) {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if err := f(); err != nil {
					mu.Lock()
					d.Errs[name] = err.Error()
					mu.Unlock()
				}
			}()
		}
		run("spend", func() (err error) { d.Spend, err = be.Spend(); return })
		run("daily", func() (err error) { d.Daily, err = be.CostsDaily(30); return })
		run("monthly", func() (err error) { d.Monthly, err = be.CostsMonthly(); return })
		run("bills", func() (err error) { d.Recon, err = be.CostsActuals(refresh); return })
		run("inventory", func() (err error) { d.Inv, err = be.Inventory(refresh); return })
		run("invoices", func() (err error) { d.Invoices, err = be.Invoices(refresh); return })
		wg.Wait()
		return costsMsg{d}
	}
}

// ---- the page --------------------------------------------------------------------------

func (m *model) costsContent(w int) string {
	d := m.costs
	if d == nil {
		return m.spin.View() + sDim.Render(" reading your spend, bills and inventory…")
	}
	var out []string
	cols := 4
	if w < 100 {
		cols = 2
	}

	// 1. the headline numbers
	var top []tile
	sp := d.Spend
	if sp != nil {
		billedNote := func(p SpendPart) string {
			if p.BilledUsd > 0.005 {
				return fmt.Sprintf("%s of it billed by your clouds", money(p.BilledUsd))
			}
			return "estimate: not billed yet"
		}
		top = append(top,
			tile{title: "Today", value: money(sp.Today.Usd), sub: billedNote(sp.Today), compact: true, subLines: 2},
			tile{title: "This week", value: money(sp.WeekToDate.Usd), sub: billedNote(sp.WeekToDate), compact: true, subLines: 2},
		)
		mt := tile{title: "This month so far", value: money(sp.MonthToDate.Usd), sub: billedNote(sp.MonthToDate), compact: true, subLines: 2}
		proj := sp.ProjectedMonthUsd
		if d.Recon != nil && d.Recon.Forecast.ProjectedUsd > 0 {
			proj = d.Recon.Forecast.ProjectedUsd
		}
		if proj > 0 {
			mt.gaugeVal, mt.gaugeMax = sp.MonthToDate.Usd, proj
		}
		top = append(top, mt)
		pt := tile{title: "Projected month", value: money(proj), sub: "if the rest of the month looks like so far", compact: true, subLines: 2}
		if f := d.Recon; f != nil && f.Forecast.DailyRateUsd > 0 {
			pt.sub = fmt.Sprintf("%s a day · basis: %s", money(f.Forecast.DailyRateUsd), f.Forecast.Basis)
		}
		top = append(top, pt)
	} else if e := d.Errs["spend"]; e != "" {
		out = append(out, sWarn.Render("Couldn't read your spend: "+e))
	}
	if len(top) > 0 {
		out = append(out, grid(top, w, cols))
	}

	// 2. what is costing money right now
	if inv := d.Inv; inv != nil {
		t := inv.Totals
		now := []tile{
			{title: "Running now", value: fmt.Sprintf("%d machine%s", t.RunningMachines, plural(t.RunningMachines)), sub: fmt.Sprintf("%s an hour · about %s a day if left on", money(t.Hourly), money(t.Hourly*24)), compact: true, subLines: 2},
			{title: "Costs even when idle", value: money(t.MonthlyStanding) + " /month", sub: "disks and snapshots: what you pay with everything stopped", compact: true, subLines: 2},
		}
		lo := tile{title: "Leftovers", value: "none", sub: "nothing is billing without a machine", compact: true, subLines: 2}
		if t.Orphans > 0 {
			lo = tile{title: "Leftovers", value: fmt.Sprintf("%d item%s", t.Orphans, plural(t.Orphans)), sub: fmt.Sprintf("%s a month for nothing: see the list below", money(t.OrphanMonthly)), tone: "bad", compact: true, subLines: 2}
		}
		now = append(now, lo)
		out = append(out, "", sectionTitle("RIGHT NOW"), grid(now, w, minInt(cols, 3)))
	} else if e := d.Errs["inventory"]; e != "" {
		out = append(out, "", sWarn.Render("Couldn't read your inventory: "+e))
	}

	// 3. daily chart
	if len(d.Daily) > 0 {
		out = append(out, "", sectionTitle("LAST "+fmt.Sprint(len(d.Daily))+" DAYS")+sDim.Render("  estimated spend per day (what your clouds actually bill is below)"))
		out = append(out, strings.Join(barChart(d.Daily, w-2, 9), "\n"))
	} else if e := d.Errs["daily"]; e != "" {
		out = append(out, "", sWarn.Render("Couldn't read the daily costs: "+e))
	}

	// 4. per cloud
	out = append(out, "", sectionTitle("BY CLOUD, THIS MONTH"))
	out = append(out, m.cloudTable(w))

	// 5. leftovers
	if inv := d.Inv; inv != nil && inv.Totals.Orphans > 0 {
		out = append(out, "", sectionTitle("LEFTOVERS THAT STILL BILL")+sDim.Render("  delete them in the cloud console, or in the web app's Infrastructure page"))
		for _, it := range inv.Items {
			if !it.Orphan {
				continue
			}
			cost := ""
			if it.MonthlyCost > 0 {
				cost = money(it.MonthlyCost) + "/mo"
			} else if it.HourlyCost > 0 {
				cost = money(it.HourlyCost) + "/h"
			}
			out = append(out, sBad.Render("▲ ")+pad(providerLabel(it.Provider), 13)+pad(it.Type, 10)+pad(truncate(it.Name, 28), 30)+sWarn.Render(pad(cost, 11))+sDim.Render(truncate(it.OrphanReason, maxInt(10, w-70))))
		}
	}

	// 6. invoices
	var inv []string
	for _, c := range d.Invoices {
		for i, iv := range c.Invoices {
			if i >= 3 {
				break
			}
			amt := "—"
			if iv.Amount != nil {
				amt = fmt.Sprintf("%.2f %s", *iv.Amount, iv.Currency)
			}
			st := iv.Status
			style := sDim
			if strings.EqualFold(st, "paid") {
				style = sGood
			} else if st != "" {
				style = sWarn
			}
			inv = append(inv, pad(c.Label, 14)+pad(iv.Period, 12)+pad(amt, 16)+style.Render(st))
		}
	}
	if len(inv) > 0 {
		out = append(out, "", sectionTitle("RECENT INVOICES"), strings.Join(inv, "\n"))
	}
	var notes []string
	if d.Recon != nil {
		for _, c := range d.Recon.Clouds {
			if c.Status == "needs-setup" {
				notes = append(notes, sWarn.Render("▲ ")+c.Label+": billed amounts need cost access switched on. The web app's Costs page has the steps and the exact command.")
			}
		}
	}
	for k, e := range d.Errs {
		if k == "bills" || k == "invoices" {
			notes = append(notes, sWarn.Render("▲ couldn't read "+k+": "+truncate(e, 80)))
		}
	}
	if len(notes) > 0 {
		sort.Strings(notes)
		out = append(out, "", strings.Join(notes, "\n"))
	}
	return strings.Join(out, "\n")
}

func (m *model) cloudTable(w int) string {
	d := m.costs
	type row struct {
		label                     string
		est, billed               float64
		hasBilled                 bool
		diffPct                   *float64
		status                    string
		running, standing, hourly float64
		machines                  int
		compute, egress, storage  float64
	}
	byP := map[string]*row{}
	get := func(p string) *row {
		if byP[p] == nil {
			byP[p] = &row{label: providerLabel(p)}
		}
		return byP[p]
	}
	if d.Monthly != nil {
		for _, b := range d.Monthly.Breakdown {
			r := get(b.Provider)
			r.compute, r.egress, r.storage = float64(b.Compute), float64(b.Egress), float64(b.Storage)
			r.est = r.compute + r.egress + r.storage
		}
	}
	if d.Recon != nil {
		for _, c := range d.Recon.Clouds {
			r := get(c.Provider)
			r.status = c.Status
			if c.Actual != nil && c.Actual.Usd != nil {
				r.billed, r.hasBilled = *c.Actual.Usd, true
			}
			r.diffPct = c.DifferencePct
			if r.est == 0 {
				r.est = c.EstimateMonthUsd
			}
		}
	}
	if d.Inv != nil {
		for p, c := range d.Inv.ByCloud {
			r := get(p)
			r.running, r.hourly, r.standing, r.machines = float64(c.Running), c.Hourly, c.Monthly, c.Machines
		}
	}
	if len(byP) == 0 {
		return sDim.Render("No spend recorded this month yet.")
	}
	var keys []string
	for k := range byP {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(a, b int) bool { return byP[keys[a]].est > byP[keys[b]].est })
	maxEst := 0.0
	for _, k := range keys {
		maxEst = math.Max(maxEst, byP[k].est)
	}
	var lines []string
	lines = append(lines, sDim.Render(pad("", 13)+pad("ESTIMATED", 11)+pad("BILLED", 11)+pad("DIFF", 8)+pad("SHARE", 14)+pad("RUNNING", 17)+"IDLE COST"))
	barW := 10
	for _, k := range keys {
		r := byP[k]
		billed := sDim.Render(pad("not shown", 11))
		if r.hasBilled {
			billed = sText.Render(pad(money(r.billed), 11))
		} else if r.status == "needs-setup" {
			billed = sWarn.Render(pad("set up", 11))
		}
		diff := sDim.Render(pad("", 8))
		if r.diffPct != nil {
			st := sGood
			if math.Abs(*r.diffPct) > 15 {
				st = sWarn
			}
			diff = st.Render(pad(fmt.Sprintf("%+.0f%%", *r.diffPct), 8))
		}
		run := sDim.Render(pad("idle", 17))
		if r.running > 0 {
			run = sGood.Render(pad(fmt.Sprintf("%.0f on · %s/h", r.running, money(r.hourly)), 17))
		}
		lines = append(lines, sBold.Render(pad(r.label, 13))+sText.Render(pad(money(r.est), 11))+billed+diff+gauge(r.est, maxEst, barW)+"    "+run+sText.Render(money(r.standing)+"/mo"))
	}
	if w > 0 {
		lines = append(lines, sDim.Render(strings.Repeat("─", minInt(w-2, 88))))
	}
	return strings.Join(lines, "\n")
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// ---- the daily chart -----------------------------------------------------------------------

var (
	colDisk    = rgb{150, 120, 235}
	colCompute = rgb{240, 150, 60}
	colEgress  = rgb{79, 214, 230}
)

// barChart: one column per day, stacked: disk at the bottom (violet), machine time (orange), data
// transfer on top (cyan). height is in text rows; each row has 8 levels.
func barChart(days []CostDay, width, height int) []string {
	if len(days) == 0 || width < 30 {
		return nil
	}
	gutter := 8
	plotW := width - gutter
	colW := plotW / len(days)
	if colW < 1 {
		colW = 1
	}
	barW := colW
	if colW >= 3 {
		barW = colW - 1
	}
	maxV := 0.0
	for _, d := range days {
		maxV = math.Max(maxV, float64(d.Total))
	}
	maxV = niceMax(maxV)
	var rows []string
	for r := 0; r < height; r++ {
		hi := maxV * float64(height-r) / float64(height)
		lo := maxV * float64(height-r-1) / float64(height)
		label := ""
		switch r {
		case 0:
			label = money(maxV)
		case height / 2:
			label = money(maxV / 2)
		case height - 1:
			label = "$0"
		}
		var b strings.Builder
		b.WriteString(sDim.Render(pad(label, gutter-2) + " ┤"))
		b.WriteString(" ")
		for _, d := range days {
			tot := float64(d.Total)
			f := (tot - lo) / (hi - lo)
			if f <= 0 {
				b.WriteString(strings.Repeat(" ", colW))
				continue
			}
			ch := "█"
			if f < 1 {
				ch = string(blocks[int(math.Max(0, math.Min(7, math.Round(f*7))))])
			}
			mid := lo + (hi-lo)*math.Min(f, 1)/2
			c := colDisk
			switch {
			case mid <= float64(d.Storage):
				c = colDisk
			case mid <= float64(d.Storage)+float64(d.Compute):
				c = colCompute
			default:
				c = colEgress
			}
			cell := lipgloss.NewStyle().Foreground(c.color()).Render(strings.Repeat(ch, barW))
			b.WriteString(cell + strings.Repeat(" ", colW-barW))
		}
		rows = append(rows, b.String())
	}
	// x axis: first, middle and last date
	axis := make([]rune, gutter+colW*len(days))
	for i := range axis {
		axis[i] = ' '
	}
	put := func(col int, s string) {
		pos := gutter + col*colW
		for i, ch := range []rune(s) {
			if pos+i >= 0 && pos+i < len(axis) {
				axis[pos+i] = ch
			}
		}
	}
	short := func(s string) string {
		if len(s) >= 10 {
			return s[5:10]
		}
		return s
	}
	put(0, short(days[0].Date))
	put(len(days)/2, short(days[len(days)/2].Date))
	if len(days) > 1 && colW*len(days) > 12 {
		put(len(days)-1-(len(short(days[len(days)-1].Date))/colW), short(days[len(days)-1].Date))
	}
	rows = append(rows, sDim.Render(string(axis)))
	legend := sDim.Render(pad("", gutter)) +
		lipgloss.NewStyle().Foreground(colDisk.color()).Render("█ disks") + "   " +
		lipgloss.NewStyle().Foreground(colCompute.color()).Render("█ machine time") + "   " +
		lipgloss.NewStyle().Foreground(colEgress.color()).Render("█ data transfer")
	return append(rows, legend)
}

func niceMax(v float64) float64 {
	if v <= 0 {
		return 1
	}
	mag := math.Pow(10, math.Floor(math.Log10(v)))
	for _, s := range []float64{1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10} {
		if v <= s*mag {
			return s * mag
		}
	}
	return 10 * mag
}
