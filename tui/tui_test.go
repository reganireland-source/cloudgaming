package main

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
)

// run executes a command (and the commands inside a batch) and returns what they produced.
// Timers (tick, spinner) are cut off after a short wait.
func run(cmd tea.Cmd) []tea.Msg {
	if cmd == nil {
		return nil
	}
	ch := make(chan tea.Msg, 1)
	go func() { ch <- cmd() }()
	select {
	case msg := <-ch:
		if b, ok := msg.(tea.BatchMsg); ok {
			var out []tea.Msg
			for _, c := range b {
				out = append(out, run(c)...)
			}
			return out
		}
		return []tea.Msg{msg}
	case <-time.After(150 * time.Millisecond):
		return nil
	}
}

type harness struct {
	t *testing.T
	m *model
}

func newHarness(t *testing.T, w, h int) *harness {
	os.Setenv("XDG_CONFIG_HOME", t.TempDir())
	os.Setenv("HOME", t.TempDir())
	m := newModel(NewDemo(), config{API: "demo"}, true)
	m.screen = scrMachines // most tests start on the Machines screen
	hr := &harness{t: t, m: m}
	hr.send(tea.WindowSizeMsg{Width: w, Height: h})
	hr.exec(m.Init())
	return hr
}

func (h *harness) send(msg tea.Msg) {
	_, cmd := h.m.Update(msg)
	h.exec(cmd)
}

func (h *harness) exec(cmd tea.Cmd) {
	queue := run(cmd)
	for n := 0; len(queue) > 0 && n < 200; n++ {
		msg := queue[0]
		queue = queue[1:]
		switch msg.(type) {
		case tickMsg, spinner.TickMsg:
			continue
		}
		_, c := h.m.Update(msg)
		queue = append(queue, run(c)...)
	}
}

func (h *harness) key(s string) {
	var k tea.KeyMsg
	switch s {
	case "enter":
		k = tea.KeyMsg{Type: tea.KeyEnter}
	case "esc":
		k = tea.KeyMsg{Type: tea.KeyEsc}
	case "tab":
		k = tea.KeyMsg{Type: tea.KeyTab}
	case "down":
		k = tea.KeyMsg{Type: tea.KeyDown}
	case "up":
		k = tea.KeyMsg{Type: tea.KeyUp}
	case "right":
		k = tea.KeyMsg{Type: tea.KeyRight}
	case "left":
		k = tea.KeyMsg{Type: tea.KeyLeft}
	case " ":
		k = tea.KeyMsg{Type: tea.KeySpace, Runes: []rune{' '}}
	default:
		k = tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(s)}
	}
	h.send(k)
}

// poll makes every refresh due and applies the results.
func (h *harness) poll() {
	h.m.last = map[string]time.Time{}
	h.exec(h.m.pollDue())
}

func (h *harness) view() string { return h.m.View() }

func show(t *testing.T, title, v string) {
	if os.Getenv("SHOW") != "" {
		fmt.Printf("\n===== %s =====\n%s\n", title, v)
	}
}

func TestLoginThenMachines(t *testing.T) {
	h := newHarness(t, 140, 44)
	h.m.authed = false
	if !strings.Contains(h.view(), "terminal edition") {
		t.Fatal("login screen missing")
	}
	show(t, "login", h.view())
	h.m.authed = true
	h.exec(h.m.afterLogin())
	h.poll()
	v := h.view()
	show(t, "machines (monitor)", v)
	for _, want := range []string{"SCUDRACE-ADELAIDE-DEV", "running", "AWS-VIRGINIA-T4", "stopped", "shelved", "GPU LOAD", "CONNECTION TO YOU", "CPU-bound", "Streaming now", "2560×1440", "MACHINES (4)"} {
		if !strings.Contains(strings.ToLower(v), strings.ToLower(want)) {
			t.Errorf("machines view lacks %q", want)
		}
	}
	full := h.m.detailContent(h.m.selected(), 120)
	for _, want := range []string{"ON THE GPU", "THIS SESSION", "ScudRaceBench", "Network errors"} {
		if !strings.Contains(strings.ToLower(full), strings.ToLower(want)) {
			t.Errorf("monitor content lacks %q", want)
		}
	}
	for i, l := range strings.Split(v, "\n") {
		if w := lenCells(l); w > 140 {
			t.Errorf("line %d is %d cells wide (> 140)", i, w)
		}
	}
	if n := len(strings.Split(v, "\n")); n != 44 {
		t.Errorf("screen is %d lines, want 44", n)
	}
}

func lenCells(s string) int { return len([]rune(stripANSI(s))) }

func stripANSI(s string) string {
	var b strings.Builder
	in := false
	for _, r := range s {
		switch {
		case r == 0x1b:
			in = true
		case in && (r == 'm' || r == 'K' || r == 'H' || r == 'J'):
			in = false
		case !in:
			b.WriteRune(r)
		}
	}
	return b.String()
}

func TestStartStopFlow(t *testing.T) {
	h := newHarness(t, 130, 40)
	h.m.authed = true
	h.exec(h.m.afterLogin())
	h.poll()
	// go to the stopped machine and start it
	h.key("down")
	if h.m.selected().Status != "stopped" {
		t.Fatalf("selected %s", h.m.selected().Status)
	}
	h.key("s")
	if h.m.prompt == nil || !strings.Contains(h.view(), "Start AWS-VIRGINIA-T4?") {
		t.Fatal("no confirmation for start")
	}
	show(t, "start prompt", h.view())
	h.key("y")
	h.poll()
	if got := h.m.selected().Status; got != "starting" {
		t.Fatalf("after start: %s", got)
	}
	show(t, "starting", h.view())
	if !strings.Contains(h.view(), "◐ STARTING") {
		t.Error("starting badge missing")
	}
	// stop key is refused for a non-running machine
	h.key("x")
	if h.m.prompt != nil {
		t.Error("stop prompt shown for a starting machine")
	}
	// wait for it to run
	time.Sleep(5200 * time.Millisecond)
	h.poll()
	if got := h.m.selected().Status; got != "running" {
		t.Fatalf("after wait: %s", got)
	}
	// stop it
	h.key("x")
	h.key("y")
	h.poll()
	if got := h.m.selected().Status; got != "stopping" {
		t.Fatalf("after stop: %s", got)
	}
}

func TestShelveRestoreDeleteRename(t *testing.T) {
	h := newHarness(t, 130, 40)
	h.m.authed = true
	h.exec(h.m.afterLogin())
	h.poll()
	h.key("down")
	h.key("down") // shelved
	if h.m.selected().Status != "shelved" {
		t.Fatal("expected shelved")
	}
	h.key("D")
	if h.m.prompt == nil || !h.m.prompt.danger {
		t.Fatal("delete should ask with a warning")
	}
	h.key("n")
	if h.m.prompt != nil {
		t.Fatal("n should cancel")
	}
	h.key("r")
	if h.m.prompt == nil || !strings.Contains(h.m.prompt.title, "Restore") {
		t.Fatal("restore prompt")
	}
	h.key("y")
	h.poll()
	if h.m.selected().Status != "restoring" {
		t.Fatalf("status %s", h.m.selected().Status)
	}
	// rename
	h.key("e")
	if h.m.prompt == nil || h.m.prompt.kind != pInput {
		t.Fatal("rename prompt")
	}
	h.m.prompt.ti.SetValue("MY-NEW-NAME")
	h.key("enter")
	h.poll()
	if h.m.selected().Name() != "MY-NEW-NAME" {
		t.Fatalf("name %q", h.m.selected().Name())
	}
	// a machine that is changing state can't be deleted
	h.key("D")
	if h.m.prompt != nil {
		t.Fatal("delete offered for a busy machine")
	}
	// the stopped one can: delete asks first
	h.key("up")
	h.key("D")
	h.key("y")
	h.poll()
	if h.m.selected().Status != "deleting" {
		t.Fatalf("status %s", h.m.selected().Status)
	}
}

func TestPairShowsPIN(t *testing.T) {
	h := newHarness(t, 130, 40)
	h.m.authed = true
	h.exec(h.m.afterLogin())
	h.poll()
	h.key("p")
	if h.m.prompt == nil || !strings.Contains(h.m.prompt.body, "moonlight pair 136.110.60.97 --pin 4821") {
		t.Fatalf("pair prompt: %+v", h.m.prompt)
	}
	show(t, "pair", h.view())
}

func TestTabsAndWindows(t *testing.T) {
	h := newHarness(t, 130, 40)
	h.m.authed = true
	h.exec(h.m.afterLogin())
	h.poll()
	h.key("right")
	h.poll()
	v := h.view()
	show(t, "connect", v)
	for _, want := range []string{"Moonlight host", "Sunshine login", "136.110.60.97", "Ready to stream"} {
		if !strings.Contains(v, want) {
			t.Errorf("connect tab lacks %q", want)
		}
	}
	if strings.Contains(v, "demo-Pass-1234") {
		t.Error("password shown before v")
	}
	h.key("v")
	if !strings.Contains(h.view(), "demo-Pass-1234") {
		t.Error("password not shown after v")
	}
	h.key("right")
	v = h.view()
	show(t, "info", v)
	if !strings.Contains(v, "Created") || !strings.Contains(v, "godot") {
		t.Error("info tab incomplete")
	}
	h.key("right")
	h.poll()
	show(t, "machine activity", h.view())
	if !strings.Contains(h.view(), "Start SCUDRACE-ADELAIDE-DEV") {
		t.Error("activity tab lacks the start operation")
	}
	h.key("left")
	h.key("left")
	h.key("left")
	h.key("w")
	if teleRanges[h.m.rangeIx].label != "1 h" {
		t.Error("window did not change")
	}
}

func TestActivityScreenAndOpLog(t *testing.T) {
	h := newHarness(t, 120, 36)
	h.m.authed = true
	h.exec(h.m.afterLogin())
	h.key("down")
	h.key("s")
	h.key("y")
	h.key("4")
	h.poll()
	show(t, "activity", h.view())
	if !strings.Contains(h.view(), "Start AWS-VIRGINIA-T4") {
		t.Fatal("new op missing from Activity")
	}
	h.key("enter")
	time.Sleep(1600 * time.Millisecond)
	h.m.opv.fetched = time.Time{}
	h.poll()
	v := h.view()
	show(t, "op log", v)
	if !strings.Contains(v, "Starting the machine") {
		t.Error("op log lacks events")
	}
	h.key("esc")
	if h.m.opv != nil {
		t.Error("esc should close the log")
	}
}

func TestLaunchWizard(t *testing.T) {
	h := newHarness(t, 120, 40)
	h.m.authed = true
	h.exec(h.m.afterLogin())
	h.key("n")
	if h.m.wiz == nil || h.m.wiz.opts == nil {
		t.Fatal("wizard not loaded")
	}
	show(t, "wizard purpose", h.view())
	h.key("down") // Game development
	h.key("enter")
	show(t, "wizard cloud", h.view())
	h.key("enter") // Google Cloud
	h.key("enter") // region
	v := h.view()
	show(t, "wizard size", v)
	if !strings.Contains(v, "[Standard]") {
		t.Error("size step lacks the intensity picker")
	}
	if got := h.m.wiz.shapes()[h.m.wiz.cursor].ID; got != "g2-standard-16" {
		t.Errorf("standard gamedev size = %s, want l4-16", got)
	}
	h.key("3")
	if got := h.m.wiz.shapes()[h.m.wiz.cursor].ID; got != "g2-standard-32" {
		t.Errorf("heavy gamedev size = %s, want l4-32", got)
	}
	h.key("1")
	if got := h.m.wiz.shapes()[h.m.wiz.cursor].ID; got != "g2-standard-16" {
		t.Errorf("light gamedev size = %s, want l4-16 (the cheapest dev size)", got)
	}
	h.key("enter")
	show(t, "wizard options", h.view())
	h.key("enter") // disk -> next field
	h.key("enter") // spot field? (no-op)
	h.m.wiz.optField = 3
	h.m.wiz.focusOpt()
	h.key("enter") // next step
	show(t, "wizard extras", h.view())
	if h.m.wiz.step != stExtras {
		t.Fatalf("step %d", h.m.wiz.step)
	}
	if !h.m.wiz.addons["godot"] || !h.m.wiz.addons["wine"] || h.m.wiz.addons["unity"] {
		t.Errorf("extras not pre-ticked from the purpose: %v", h.m.wiz.addons)
	}
	h.key("enter")
	v = h.view()
	show(t, "wizard review", v)
	if !strings.Contains(v, "Review") || !strings.Contains(v, "godot") {
		t.Error("review incomplete")
	}
	h.key("enter") // launch
	time.Sleep(50 * time.Millisecond)
	if h.m.screen != scrActivity || h.m.opv == nil {
		t.Fatalf("after launch: screen %v opv %v err %q", h.m.screen, h.m.opv, "")
	}
	h.poll()
	if len(h.m.machines) != 4 || h.m.machines[0].Status != "creating" {
		t.Errorf("new machine missing: %d machines", len(h.m.machines))
	}
}

func TestLocalPCs(t *testing.T) {
	h := newHarness(t, 140, 40)
	h.m.authed = true
	h.exec(h.m.afterLogin())
	h.key("2")
	h.poll()
	for i := 0; i < 3; i++ { // past the three cloud machines: your own PCs share the list
		h.key("down")
	}
	h.poll()
	h.poll()
	v := h.view()
	show(t, "local", v)
	if !strings.Contains(v, "Big Gaming PC") || !strings.Contains(v, "ONLINE") || !strings.Contains(v, "GPU LOAD") {
		t.Error("local PC detail incomplete on the Machines screen")
	}
	if !strings.Contains(strings.Join(h.m.footerLines(), "\n"), "window") {
		t.Error("local PC hints missing")
	}
}

func TestNarrowTerminal(t *testing.T) {
	h := newHarness(t, 80, 30)
	h.m.authed = true
	h.exec(h.m.afterLogin())
	h.poll()
	v := h.view()
	show(t, "narrow", v)
	for i, l := range strings.Split(v, "\n") {
		if w := lenCells(l); w > 80 {
			t.Errorf("line %d is %d cells wide (> 80): %q", i, w, stripANSI(l))
		}
	}
}

func TestHelp(t *testing.T) {
	h := newHarness(t, 100, 40)
	h.m.authed = true
	h.key("?")
	if !strings.Contains(h.view(), "KEYS") {
		t.Fatal("no help")
	}
	h.key("x")
	if h.m.help {
		t.Fatal("help should close")
	}
}

func TestFailedHiddenAndHardware(t *testing.T) {
	h := newHarness(t, 150, 46)
	h.m.authed = true
	h.exec(h.m.afterLogin())
	h.poll()
	if len(h.m.allMachines) != 9 || len(h.m.machines) != 3 || h.m.failedCount != 6 {
		t.Fatalf("all %d shown %d failed %d", len(h.m.allMachines), len(h.m.machines), h.m.failedCount)
	}
	v := h.view()
	show(t, "hardware + hidden failed", v)
	for _, want := range []string{"6 failed hidden", "GPU", "NVIDIA L4", "32 vCPU", "128 GB", "VRAM", "MEMORY", "DISK", "300 GB"} {
		if !strings.Contains(v, want) {
			t.Errorf("machines view lacks %q", want)
		}
	}
	if strings.Contains(v, "AWS-MUMBAI") {
		t.Error("failed machines are visible by default")
	}
	h.key("f")
	if len(h.m.machines) != 9 || !strings.Contains(h.view(), "AWS-MUMBAI") {
		t.Error("f should show the failed machines")
	}
	h.key("f")
	if len(h.m.machines) != 3 {
		t.Error("f again should hide them")
	}
}

func TestCostsPage(t *testing.T) {
	h := newHarness(t, 150, 50)
	h.m.authed = true
	h.exec(h.m.afterLogin())
	h.key("5")
	h.poll()
	h.poll()
	v := h.m.costsContent(146)
	show(t, "costs", h.view())
	for _, want := range []string{"TODAY", "THIS MONTH SO FAR", "PROJECTED MONTH", "RIGHT NOW", "COSTS EVEN WHEN IDLE", "LEFTOVERS", "LAST 30 DAYS", "machine time", "BY CLOUD", "Google Cloud", "AWS", "RECENT INVOICES", "vol-0a1b2c", "set up"} {
		if !strings.Contains(strings.ToUpper(v), strings.ToUpper(want)) {
			t.Errorf("costs page lacks %q", want)
		}
	}
	for i, l := range strings.Split(h.view(), "\n") {
		if lenCells(l) > 150 {
			t.Errorf("costs line %d is %d cells", i, lenCells(l))
		}
	}
}

func TestRegionsPage(t *testing.T) {
	h := newHarness(t, 150, 50)
	h.m.authed = true
	h.exec(h.m.afterLogin())
	h.key("6")
	h.poll()
	h.poll()
	v := h.view()
	show(t, "regions", v)
	for _, want := range []string{"Google Cloud · 2/6 ready", "Singapore", "READY", "NO QUOTA", "YOUR QUOTAS", "WHAT YOU CAN RUN HERE", "AWS · 1/3 ready"} {
		if !strings.Contains(v, want) {
			t.Errorf("regions page lacks %q", want)
		}
	}
	// ready ones come first
	list := h.m.regionList()
	if list[0].Status != "ready" || list[len(list)-1].Status == "ready" {
		t.Errorf("not sorted by usefulness: %+v", list)
	}
	h.key("f")
	if got := len(h.m.regionList()); got != 2 {
		t.Errorf("ready-only shows %d", got)
	}
	h.key("f")
	h.key("down")
	h.key("down") // a no-quota region
	d := h.m.regionDetail(h.m.selectedRegion(h.m.regionList()), 100)
	show(t, "regions no-quota", d)
	if !strings.Contains(d, "HOW TO FIX IT") || !strings.Contains(d, "gcloud alpha") {
		t.Error("no-quota region lacks the fix")
	}
	h.key("right")
	if !strings.Contains(h.view(), "Ready") && h.m.cloudSel != 1 {
		t.Error("cloud tab did not move")
	}
	h.key("right")
	h.key("right")
	if !strings.Contains(h.view(), "isn't connected") {
		t.Error("unconnected cloud not explained")
	}
}

func TestDashboardAndPerformance(t *testing.T) {
	for _, size := range [][2]int{{150, 50}, {120, 36}, {100, 46}, {80, 30}} {
		h := newHarness(t, size[0], size[1])
		h.m.authed = true
		h.exec(h.m.afterLogin())
		h.key("1")
		h.poll()
		h.poll()
		h.poll()
		v := h.view()
		show(t, fmt.Sprintf("dashboard %d", size[0]), v)
		if !strings.Contains(v, "Dash") {
			t.Errorf("%d: no Dashboard tab", size[0])
		}
		content := h.m.dashContent(size[0] - 1)
		for _, want := range []string{"RUNNING NOW", "THIS MONTH", "STANDING COST", "LEFTOVERS", "GPU LOAD (AVG)", "STREAMING NOW", "ACTIVE MACHINES", "SCUDRACE-ADELAIDE-DEV", "NEEDS ATTENTION", "RECENT ACTIVITY"} {
			if !strings.Contains(strings.ToUpper(content), want) {
				t.Errorf("%d: dashboard lacks %q", size[0], want)
			}
		}
		for i, l := range strings.Split(v, "\n") {
			if w := lenCells(l); w > size[0] {
				t.Errorf("dashboard %d: line %d is %d cells", size[0], i, w)
			}
		}
		h.key("3")
		h.poll()
		h.poll()
		pv := h.view()
		show(t, fmt.Sprintf("performance %d", size[0]), pv)
		for _, want := range []string{"PERFORMANCE", "SCUDRACE-ADELAIDE-DEV", "GPU"} {
			if !strings.Contains(strings.ToUpper(pv), want) {
				t.Errorf("%d: performance lacks %q", size[0], want)
			}
		}
		for i, l := range strings.Split(pv, "\n") {
			if w := lenCells(l); w > size[0] {
				t.Errorf("performance %d: line %d is %d cells", size[0], i, w)
			}
		}
		// what is on gets the verbose view (the local PC too); the rest is one line each
		if !strings.Contains(pv, "Big Gaming PC") {
			t.Errorf("%d: the local PC is missing from Performance", size[0])
		}
		if size[1] >= 46 { // tall enough for the verbose view: tiles for what is on, a line each for the rest
			if !strings.Contains(strings.ToUpper(pv), "NOT RUNNING (2)") || !strings.Contains(strings.ToUpper(pv), "GPU LOAD") {
				t.Errorf("%d: verbose Performance incomplete", size[0])
			}
		}
		h.key("down") // the local PC is the second machine that is on
		h.key("enter")
		if h.m.screen != scrMachines || h.m.selectedLocal() == nil {
			t.Errorf("%d: enter should open the local PC on Machines (screen %d)", size[0], h.m.screen)
		}
	}
}
