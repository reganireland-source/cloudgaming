package main

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
)

// The launch wizard: "what is this machine for?" first (it sets the size,
// disk and extra tools), then cloud, region, size, options, extra tools, review.

const (
	stPurpose = iota
	stCloud
	stRegion
	stSize
	stOptions
	stExtras
	stReview
	stCount
)

var stepNames = []string{"What is it for?", "Cloud", "Region", "Size", "Options", "Extra tools", "Review"}
var autoStops = []int{0, 10, 15, 30, 60, 120}

type wizard struct {
	opts      *Options
	loadErr   string
	step      int
	cursor    int
	purposeIx int // index into opts.Purposes; len = Custom
	intensity int // 0 light, 1 standard, 2 heavy
	toggles   map[string]bool
	provIx    int
	regionIx  int
	shapeIx   int
	picked    bool // a size chosen by hand beats the purpose's pick
	disk      textinput.Model
	name      textinput.Model
	spot      bool
	autoIx    int
	optField  int
	addons    map[string]bool
	err       string
	launching bool
}

func (m *model) openWizard() tea.Cmd {
	m.screen = scrWizard
	m.wiz = &wizard{intensity: 1, autoIx: 2, toggles: map[string]bool{}, addons: map[string]bool{}}
	if m.options != nil {
		m.wiz.start(m.options)
		return nil
	}
	return m.cmdOptions()
}

func (w *wizard) start(o *Options) {
	w.opts = o
	w.purposeIx = 0
	w.cursor = 0
	d := textinput.New()
	d.CharLimit = 5
	d.Width = 8
	w.disk = d
	n := textinput.New()
	n.CharLimit = 40
	n.Placeholder = "(suggested name)"
	n.Width = 40
	w.name = n
}

func (w *wizard) purpose() *Purpose {
	if w.opts == nil || w.purposeIx >= len(w.opts.Purposes) {
		return nil
	}
	return &w.opts.Purposes[w.purposeIx]
}

func (w *wizard) provider() *ProviderOpt {
	if w.opts == nil || w.provIx >= len(w.opts.Providers) {
		return nil
	}
	return &w.opts.Providers[w.provIx]
}

func (w *wizard) region() *Region {
	p := w.provider()
	if p == nil || w.regionIx >= len(p.Regions) {
		return nil
	}
	return &p.Regions[w.regionIx]
}

// shapes offered in the chosen region (those with a GPU the region has).
func (w *wizard) shapes() []Shape {
	p, r := w.provider(), w.region()
	if p == nil || r == nil {
		return nil
	}
	var out []Shape
	for _, s := range p.Shapes {
		for _, g := range r.GPUs {
			if g == s.GPUModel {
				out = append(out, s)
				break
			}
		}
	}
	return out
}

func (w *wizard) price(s Shape) Price {
	if r := w.region(); r != nil {
		return s.Prices[r.ID]
	}
	return Price{}
}

// pickShape: the size a purpose suggests (cheapest / middle / strongest that fits its needs).
func (w *wizard) pickShape() int {
	shapes := w.shapes()
	if len(shapes) == 0 {
		return 0
	}
	pu := w.purpose()
	if pu == nil {
		return 0
	}
	fits := func(s Shape, dev bool) bool {
		return s.VCPUs >= pu.Size.MinVcpus && s.MemoryGb >= pu.Size.MinMemoryGb && (!dev || !pu.Size.DevTier || s.Dev || s.AlsoDev)
	}
	var pool []int
	for i, s := range shapes {
		if fits(s, true) {
			pool = append(pool, i)
		}
	}
	if len(pool) == 0 {
		for i, s := range shapes {
			if fits(s, false) {
				pool = append(pool, i)
			}
		}
	}
	if pu.ID == "play" {
		pool = nil
		for i, s := range shapes {
			if !s.Dev {
				pool = append(pool, i)
			}
		}
	}
	if len(pool) == 0 {
		return 0
	}
	sort.SliceStable(pool, func(a, b int) bool { return w.price(shapes[pool[a]]).OnDemand < w.price(shapes[pool[b]]).OnDemand })
	switch w.intensity {
	case 0:
		return pool[0]
	case 2:
		return pool[len(pool)-1]
	}
	return pool[(len(pool)-1)/2]
}

// applyPurpose sets the tool ticks, disk and quality from the chosen purpose.
func (w *wizard) applyPurpose() {
	w.addons = map[string]bool{}
	w.toggles = map[string]bool{}
	pu := w.purpose()
	if pu == nil {
		return
	}
	for _, a := range pu.Addons {
		w.addons[a] = true
	}
	for _, t := range pu.Toggles {
		w.toggles[t.ID] = t.Default
		if t.Default {
			for _, a := range t.Addons {
				w.addons[a] = true
			}
		}
	}
}

func (w *wizard) enterStep(s int) {
	w.step, w.err, w.cursor = s, "", 0
	switch s {
	case stCloud:
		for i, p := range w.opts.Providers {
			if p.Configured && p.Available {
				w.cursor = i
				break
			}
		}
	case stRegion:
		if p := w.provider(); p != nil {
			for i, r := range p.Regions {
				if r.ID == p.DefaultRegion {
					w.cursor = i
				}
			}
		}
	case stSize:
		if !w.picked {
			w.shapeIx = w.pickShape()
		}
		w.cursor = w.shapeIx
	case stOptions:
		p := w.provider()
		d := 150.0
		if p != nil {
			d = p.DefaultDiskGb
		}
		if pu := w.purpose(); pu != nil && pu.DiskGb > d {
			d = pu.DiskGb
		}
		if sh := w.shapes(); w.shapeIx < len(sh) && sh[w.shapeIx].DefaultDiskGb > d {
			d = sh[w.shapeIx].DefaultDiskGb
		}
		if w.disk.Value() == "" {
			w.disk.SetValue(strconv.Itoa(int(d)))
		}
		w.optField = 0
		w.disk.Focus()
		w.name.Blur()
	}
}

func (m *model) wizardKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	w := m.wiz
	if w.opts == nil {
		if k.String() == "esc" || k.String() == "q" {
			m.wiz, m.screen = nil, scrMachines
		}
		return m, nil
	}
	if w.launching {
		return m, nil
	}
	key := k.String()
	// text fields take typing first
	if w.step == stOptions && (w.optField == 0 || w.optField == 3) {
		switch key {
		case "up", "shift+tab":
			w.optField = (w.optField + 3) % 4
			w.focusOpt()
			return m, nil
		case "down", "tab", "enter":
			if key == "enter" && w.optField == 3 {
				return m, w.next(m)
			}
			w.optField = (w.optField + 1) % 4
			w.focusOpt()
			return m, nil
		case "esc":
			return m, w.back(m)
		}
		var c tea.Cmd
		if w.optField == 0 {
			w.disk, c = w.disk.Update(k)
		} else {
			w.name, c = w.name.Update(k)
		}
		return m, c
	}
	switch key {
	case "esc":
		return m, w.back(m)
	case "left", "h", "backspace":
		if w.step == stOptions && w.optField == 2 {
			if w.autoIx > 0 {
				w.autoIx--
			}
			return m, nil
		}
		return m, w.back(m)
	case "up", "k":
		if w.step == stOptions {
			w.optField = (w.optField + 3) % 4
			w.focusOpt()
		} else if w.cursor > 0 {
			w.cursor--
		}
	case "down", "j":
		if w.step == stOptions {
			w.optField = (w.optField + 1) % 4
			w.focusOpt()
		} else if w.cursor < w.listLen()-1 {
			w.cursor++
		}
	case "right", "l":
		if w.step == stOptions && w.optField == 2 && w.autoIx < len(autoStops)-1 {
			w.autoIx++
		}
	case " ", "x":
		switch w.step {
		case stOptions:
			if w.optField == 1 {
				if p := w.provider(); p != nil && p.SupportsSpot {
					w.spot = !w.spot
				}
			}
		case stExtras:
			if w.cursor < len(w.opts.AddonCatalog.Addons) {
				id := w.opts.AddonCatalog.Addons[w.cursor].ID
				w.addons[id] = !w.addons[id]
			}
		}
	case "1", "2", "3":
		if w.step == stSize {
			w.intensity = int(key[0] - '1')
			w.picked = false
			w.shapeIx = w.pickShape()
			w.cursor = w.shapeIx
		}
	case "enter", "tab":
		if w.step == stOptions && w.optField < 3 {
			w.optField++
			w.focusOpt()
			return m, nil
		}
		return m, w.next(m)
	}
	return m, nil
}

func (w *wizard) focusOpt() {
	w.disk.Blur()
	w.name.Blur()
	if w.optField == 0 {
		w.disk.Focus()
	} else if w.optField == 3 {
		w.name.Focus()
	}
}

func (w *wizard) listLen() int {
	switch w.step {
	case stPurpose:
		return len(w.opts.Purposes) + 1
	case stCloud:
		return len(w.opts.Providers)
	case stRegion:
		if p := w.provider(); p != nil {
			return len(p.Regions)
		}
	case stSize:
		return len(w.shapes())
	case stExtras:
		return len(w.opts.AddonCatalog.Addons)
	}
	return 0
}

func (w *wizard) back(m *model) tea.Cmd {
	if w.step == stPurpose {
		m.wiz, m.screen = nil, scrMachines
		return nil
	}
	w.enterStep(w.step - 1)
	return nil
}

func (w *wizard) next(m *model) tea.Cmd {
	w.err = ""
	switch w.step {
	case stPurpose:
		w.purposeIx = w.cursor
		w.picked = false
		w.applyPurpose()
		w.enterStep(stCloud)
	case stCloud:
		p := w.opts.Providers[w.cursor]
		if !p.Available {
			w.err = p.Label + " launching isn't available yet."
			return nil
		}
		if !p.Configured {
			w.err = "Add your " + p.Label + " keys in the web app (Config page) first."
			return nil
		}
		w.provIx = w.cursor
		w.regionIx, w.shapeIx, w.picked = 0, 0, false
		w.enterStep(stRegion)
	case stRegion:
		w.regionIx = w.cursor
		w.picked = false
		w.enterStep(stSize)
	case stSize:
		if len(w.shapes()) == 0 {
			w.err = "No sizes in this region: pick another."
			return nil
		}
		if w.cursor != w.pickShapeNoCursor() {
			w.picked = true
		}
		w.shapeIx = w.cursor
		w.enterStep(stOptions)
	case stOptions:
		d, err := strconv.Atoi(strings.TrimSpace(w.disk.Value()))
		p := w.provider()
		if err != nil || (p != nil && float64(d) < p.MinDiskGb) || d > 2000 {
			w.err = "Disk size must be a whole number of GB" + func() string {
				if p != nil {
					return fmt.Sprintf(" (at least %.0f)", p.MinDiskGb)
				}
				return ""
			}() + "."
			w.optField = 0
			w.focusOpt()
			return nil
		}
		w.enterStep(stExtras)
	case stExtras:
		w.enterStep(stReview)
	case stReview:
		return w.launch(m)
	}
	return nil
}

func (w *wizard) pickShapeNoCursor() int { return w.pickShape() }

// ticked add-ons plus what they need, in the order shown.
func (w *wizard) allAddons() []string {
	var out []string
	by := map[string]AddonInfo{}
	for _, a := range w.opts.AddonCatalog.Addons {
		by[a.ID] = a
	}
	seen := map[string]bool{}
	var add func(id string)
	add = func(id string) {
		if seen[id] {
			return
		}
		seen[id] = true
		for _, r := range by[id].Requires {
			add(r)
		}
		out = append(out, id)
	}
	for _, a := range w.opts.AddonCatalog.Addons {
		if w.addons[a.ID] {
			add(a.ID)
		}
	}
	return out
}

func (w *wizard) extraDisk() float64 {
	by := map[string]AddonInfo{}
	for _, a := range w.opts.AddonCatalog.Addons {
		by[a.ID] = a
	}
	t := 0.0
	for _, id := range w.allAddons() {
		t += by[id].DiskGb
	}
	return t
}

func (w *wizard) request() LaunchReq {
	p, r := w.provider(), w.region()
	sh := w.shapes()
	d, _ := strconv.Atoi(strings.TrimSpace(w.disk.Value()))
	req := LaunchReq{Provider: p.Provider, Region: r.ID, ShapeID: sh[w.shapeIx].ID, DiskSizeGb: d, Spot: w.spot && p.SupportsSpot,
		Quality: "high", AutoStopMinutes: autoStops[w.autoIx], Nickname: strings.TrimSpace(w.name.Value())}
	if pu := w.purpose(); pu != nil && pu.Quality != "" {
		req.Quality = pu.Quality
	}
	days := 7
	req.AutoShelveDays = &days
	req.Addons = []AddonRequest{}
	for _, a := range w.opts.AddonCatalog.Addons {
		if w.addons[a.ID] {
			req.Addons = append(req.Addons, AddonRequest{ID: a.ID})
		}
	}
	return req
}

func (w *wizard) launch(m *model) tea.Cmd {
	w.launching = true
	req := w.request()
	be := m.be
	return func() tea.Msg {
		mid, oid, err := be.Launch(req)
		return launchMsg{mid, oid, err}
	}
}

// ---- view ------------------------------------------------------------------------

func (m *model) wizardView(width, height int) string {
	w := m.wiz
	var b strings.Builder
	// progress
	var steps []string
	for i, n := range stepNames {
		switch {
		case w.opts == nil:
		case i < w.step:
			steps = append(steps, sGood.Render("✓ "+n))
		case i == w.step:
			steps = append(steps, sKey.Render("● "+n))
		default:
			steps = append(steps, sDim.Render("○ "+n))
		}
	}
	b.WriteString(sTitle.Render("NEW MACHINE") + "  " + strings.Join(steps, sDim.Render(" › ")) + "\n\n")
	if w.opts == nil {
		if w.loadErr != "" {
			b.WriteString(sBad.Render("✖ "+w.loadErr) + "\n\n" + sDim.Render("esc back"))
		} else {
			b.WriteString(m.spin.View() + " loading launch options…")
		}
		return b.String()
	}
	body := height - 6
	if body < 6 {
		body = 6
	}
	switch w.step {
	case stPurpose:
		b.WriteString(sBold.Render("What is this machine for?") + sDim.Render("  It sets the size, disk and tools; you can change all of it.") + "\n\n")
		var rows []string
		for _, p := range w.opts.Purposes {
			rows = append(rows, p.Name)
		}
		rows = append(rows, "Custom: choose everything yourself")
		b.WriteString(listView(rows, w.cursor, body-4))
		b.WriteString("\n")
		if w.cursor < len(w.opts.Purposes) {
			b.WriteString(sDim.Render(strings.Join(wrap(w.opts.Purposes[w.cursor].Blurb, width-4), "\n")))
		} else {
			b.WriteString(sDim.Render("Nothing is pre-selected: pick the cloud, size and tools yourself."))
		}
	case stCloud:
		b.WriteString(sBold.Render("Which cloud?") + "\n\n")
		var rows []string
		for _, p := range w.opts.Providers {
			status := sGood.Render("ready")
			switch {
			case !p.Available:
				status = sDim.Render("coming soon")
			case !p.Configured:
				status = sWarn.Render("no keys yet")
			}
			rows = append(rows, pad(p.Label, 16)+status)
		}
		b.WriteString(listView(rows, w.cursor, body))
	case stRegion:
		p := w.provider()
		b.WriteString(sBold.Render("Which region?") + sDim.Render("  Pick the one closest to you: distance adds lag.") + "\n\n")
		var rows []string
		for _, r := range p.Regions {
			rows = append(rows, pad(r.Name, 22)+sDim.Render(r.ID+" · "+strings.Join(r.GPUs, ", ")))
		}
		b.WriteString(listView(rows, w.cursor, body))
	case stSize:
		b.WriteString(sBold.Render("Which size?"))
		if pu := w.purpose(); pu != nil {
			names := []string{"Light", "Standard", "Heavy"}
			var ch []string
			for i, n := range names {
				if i == w.intensity {
					ch = append(ch, sKey.Render("["+n+"]"))
				} else {
					ch = append(ch, sDim.Render(n))
				}
			}
			b.WriteString("   " + strings.Join(ch, " ") + sDim.Render("   press 1 2 3 to change how big"))
		}
		b.WriteString("\n\n")
		var rows []string
		for _, s := range w.shapes() {
			pr := w.price(s)
			price := fmt.Sprintf("%s/h", money(pr.OnDemand))
			if pr.Spot != nil && w.provider().SupportsSpot {
				price += fmt.Sprintf(" (spot %s)", money(*pr.Spot))
			}
			rows = append(rows, pad(s.Label, 34)+sDim.Render(price))
		}
		b.WriteString(listView(rows, w.cursor, body-3))
		if sh := w.shapes(); w.cursor < len(sh) && sh[w.cursor].BestFor != "" {
			b.WriteString("\n" + sDim.Render(strings.Join(wrap(sh[w.cursor].BestFor, width-4), "\n")))
		}
	case stOptions:
		p := w.provider()
		b.WriteString(sBold.Render("Options") + "\n\n")
		field := func(i int, label, val string) {
			mark := "  "
			if w.optField == i {
				mark = sKey.Render("▸ ")
			}
			b.WriteString(mark + pad(label, 22) + val + "\n")
		}
		field(0, "Disk size (GB)", w.disk.View())
		spot := "off (on-demand)"
		switch {
		case !p.SupportsSpot:
			spot = sDim.Render("not offered here")
		case w.spot:
			spot = sWarn.Render("ON: cheaper, but the cloud can take it back") + sDim.Render("  (space)")
		default:
			spot = "off (on-demand)" + sDim.Render("  (space)")
		}
		field(1, "Spot pricing", spot)
		as := "never"
		if autoStops[w.autoIx] > 0 {
			as = fmt.Sprintf("after %d minutes without streaming", autoStops[w.autoIx])
		}
		field(2, "Auto-stop", as+sDim.Render("  (← →)"))
		field(3, "Name", w.name.View())
		b.WriteString("\n" + sDim.Render("The disk is billed even while the machine is stopped. Auto-stop shuts a forgotten machine down."))
	case stExtras:
		b.WriteString(sBold.Render("Extra tools") + sDim.Render("  space ticks, enter continues. Nothing is signed in or activated for you.") + "\n\n")
		var rows []string
		have := map[string]bool{}
		for _, id := range w.allAddons() {
			have[id] = true
		}
		for _, a := range w.opts.AddonCatalog.Addons {
			box := "[ ]"
			switch {
			case w.addons[a.ID]:
				box = sGood.Render("[x]")
			case have[a.ID]:
				box = sDim.Render("[+]")
			}
			note := fmt.Sprintf("≈%.1f GB", a.DiskGb)
			if a.Experimental {
				note += " · experimental"
			}
			if !w.addons[a.ID] && have[a.ID] {
				note += " · needed by another tool"
			}
			rows = append(rows, box+" "+pad(a.Name, 30)+sDim.Render(note))
		}
		b.WriteString(listView(rows, w.cursor, body-4))
		if w.cursor < len(w.opts.AddonCatalog.Addons) {
			b.WriteString("\n" + sDim.Render(strings.Join(wrap(w.opts.AddonCatalog.Addons[w.cursor].Description, width-4), "\n")))
		}
		if x := w.extraDisk(); x > 0 {
			b.WriteString("\n" + sWarn.Render(fmt.Sprintf("These add about %.0f GB: leave room on the disk.", x)))
		}
	case stReview:
		req := w.request()
		sh := w.shapes()[w.shapeIx]
		pr := w.price(sh)
		hourly := pr.OnDemand
		if req.Spot && pr.Spot != nil {
			hourly = *pr.Spot
		}
		disk := float64(req.DiskSizeGb) * w.provider().DiskPerGbMo
		b.WriteString(sBold.Render("Review") + "\n\n")
		row := func(k, v string) { b.WriteString(pad(k, 14) + v + "\n") }
		if pu := w.purpose(); pu != nil {
			row("Purpose", pu.Name)
		}
		row("Cloud", w.provider().Label+" · "+w.region().Name+" ("+w.region().ID+")")
		row("Size", sh.Label)
		row("Disk", fmt.Sprintf("%d GB", req.DiskSizeGb))
		row("Pricing", map[bool]string{true: "spot", false: "on-demand"}[req.Spot])
		as := "never"
		if req.AutoStopMinutes > 0 {
			as = fmt.Sprintf("after %d idle minutes", req.AutoStopMinutes)
		}
		row("Auto-stop", as)
		if req.Nickname != "" {
			row("Name", req.Nickname)
		}
		ids := w.allAddons()
		if len(ids) == 0 {
			row("Extra tools", sDim.Render("none"))
		} else {
			row("Extra tools", strings.Join(ids, ", "))
		}
		b.WriteString("\n" + sGood.Render(fmt.Sprintf("≈ %s/hour while running", money(hourly))) + sDim.Render(fmt.Sprintf(" · %s/month for the disk, even when stopped", money(disk))) + "\n")
		if w.launching {
			b.WriteString("\n" + m.spin.View() + " launching…")
		} else {
			b.WriteString("\n" + sKey.Render("enter") + " launch · " + sKey.Render("esc") + " back")
		}
	}
	if w.err != "" {
		b.WriteString("\n\n" + sBad.Render("✖ "+w.err))
	}
	b.WriteString("\n\n" + sDim.Render("↑↓ choose · enter next · esc back (first step: cancel)"))
	return b.String()
}

// listView draws rows with a ▸ on the cursor, scrolling to keep it in view.
func listView(rows []string, cursor, height int) string {
	if height < 3 {
		height = 3
	}
	start := 0
	if cursor >= height {
		start = cursor - height + 1
	}
	var out []string
	for i := start; i < len(rows) && i < start+height; i++ {
		if i == cursor {
			out = append(out, sKey.Render("▸ ")+sBold.Render(rows[i]))
		} else {
			out = append(out, "  "+rows[i])
		}
	}
	return strings.Join(out, "\n")
}
