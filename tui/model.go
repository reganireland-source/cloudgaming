package main

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type screenID int

const (
	scrDashboard screenID = iota
	scrMachines
	scrPerf
	scrActivity
	scrCosts
	scrRegions
	scrWizard
)

type detailTab int

const (
	tabMonitor detailTab = iota
	tabConnect
	tabInfo
	tabActivity
)

var tabNames = []string{"Monitor", "Connect", "Info", "Activity"}

var teleRanges = []struct {
	label   string
	minutes int
}{{"15 min", 15}, {"1 h", 60}, {"6 h", 360}, {"24 h", 1440}}

// ---- messages ----------------------------------------------------------------

type tickMsg time.Time
type statusMsg struct {
	s   *SystemStatus
	err error
}
type spendMsg struct {
	s   *Spend
	err error
}
type machinesMsg struct {
	m   []Machine
	err error
}
type teleMsg struct {
	id    string
	local bool
	t     *Telemetry
	err   error
}
type connMsg struct {
	id  string
	c   *Connection
	err error
}
type opsMsg struct {
	machineID string
	ops       []OpSummary
	err       error
}
type opMsg struct {
	op  *Operation
	err error
}
type localMsg struct {
	l   []LocalMachine
	err error
}
type optionsMsg struct {
	o   *Options
	err error
}
type actMsg struct {
	label string
	res   map[string]any
	err   error
	pin   bool
}
type launchMsg struct {
	machineID, opID string
	err             error
}
type loginMsg struct {
	token string
	err   error
}
type meMsg struct {
	u   *User
	err error
}

// ---- prompts (confirm / type a value / show something) ------------------------

type promptKind int

const (
	pConfirm promptKind = iota
	pInput
	pInfo
)

type prompt struct {
	kind   promptKind
	title  string
	body   string
	danger bool
	ti     textinput.Model
	run    func(m *model, val string) tea.Cmd
}

// ---- the model -----------------------------------------------------------------

type model struct {
	be   Backend
	cfg  config
	demo bool
	w, h int

	authed bool
	user   *User
	login  loginModel

	screen screenID
	status *SystemStatus
	spend  *Spend

	allMachines []Machine // everything the backend sent
	machines    []Machine // what is listed (failed ones hidden unless f)
	showFailed  bool
	failedCount int
	sel         int
	loaded      bool
	detail      detailTab
	rangeIx     int
	tele        map[string]*Telemetry
	teleErr     map[string]string
	conn        map[string]*Connection
	mops        map[string][]OpSummary
	showPass    bool
	vp          viewport.Model

	ops   []OpSummary
	opSel int
	opv   *opView

	costs *costsData
	cvp   viewport.Model

	regions        *RegionAccessResp
	regionsErr     string
	regionsLoading bool
	cloudSel       int
	regSel         int
	readyOnly      bool
	rvp            viewport.Model

	local     []LocalMachine // your own PCs: listed with the cloud machines (Machines, Performance, Dashboard)
	localTele map[string]*Telemetry
	psel      int // selected card on Performance
	pvp       viewport.Model
	dvp       viewport.Model
	inv       *Inventory // dashboard: live standing costs and leftovers

	options *Options
	wiz     *wizard

	prompt *prompt
	help   bool
	spin   spinner.Model

	notice    string
	noticeBad bool
	noticeAt  time.Time
	last      map[string]time.Time
	inflight  map[string]bool
	err       string
	quitting  bool
}

func newModel(be Backend, cfg config, demo bool) *model {
	sp := spinner.New()
	sp.Spinner = spinner.MiniDot
	sp.Style = sAccent
	return &model{
		be: be, cfg: cfg, demo: demo, w: 120, h: 36, spin: sp,
		tele: map[string]*Telemetry{}, teleErr: map[string]string{}, conn: map[string]*Connection{}, mops: map[string][]OpSummary{},
		localTele: map[string]*Telemetry{}, last: map[string]time.Time{}, inflight: map[string]bool{},
		rangeIx: 0, login: newLogin(),
		vp: viewport.New(60, 20), pvp: viewport.New(60, 20), dvp: viewport.New(60, 20), cvp: viewport.New(60, 20), rvp: viewport.New(60, 20),
	}
}

func (m *model) Init() tea.Cmd {
	cmds := []tea.Cmd{m.spin.Tick, tick()}
	if m.cfg.Token != "" || m.demo {
		cmds = append(cmds, m.checkMe())
	}
	return tea.Batch(cmds...)
}

func tick() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg { return tickMsg(t) })
}

// ---- commands ---------------------------------------------------------------------

func (m *model) checkMe() tea.Cmd {
	be := m.be
	return func() tea.Msg { u, err := be.Me(); return meMsg{u, err} }
}

func (m *model) cmdStatus() tea.Cmd {
	be := m.be
	return func() tea.Msg {
		s, err := be.Status()
		return statusMsg{s, err}
	}
}

func (m *model) cmdSpend() tea.Cmd {
	be := m.be
	return func() tea.Msg {
		s, err := be.Spend()
		return spendMsg{s, err}
	}
}

func (m *model) cmdMachines() tea.Cmd {
	be := m.be
	return func() tea.Msg {
		l, err := be.Machines()
		return machinesMsg{l, err}
	}
}

func (m *model) cmdTele(id string, local bool) tea.Cmd {
	be, mins := m.be, teleRanges[m.rangeIx].minutes
	return func() tea.Msg {
		t, err := be.Telemetry(local, id, mins)
		return teleMsg{id, local, t, err}
	}
}

func (m *model) cmdConn(id string) tea.Cmd {
	be := m.be
	return func() tea.Msg {
		c, err := be.Connection(id)
		return connMsg{id, c, err}
	}
}

func (m *model) cmdOps(machineID string) tea.Cmd {
	be := m.be
	return func() tea.Msg {
		o, err := be.Operations(40, machineID)
		return opsMsg{machineID, o, err}
	}
}

func (m *model) cmdOp(id string, after int) tea.Cmd {
	be := m.be
	return func() tea.Msg {
		o, err := be.Operation(id, after)
		return opMsg{o, err}
	}
}

func (m *model) cmdLocal() tea.Cmd {
	be := m.be
	return func() tea.Msg {
		l, err := be.LocalMachines()
		return localMsg{l, err}
	}
}

func (m *model) cmdOptions() tea.Cmd {
	be := m.be
	return func() tea.Msg {
		o, err := be.Options()
		return optionsMsg{o, err}
	}
}

func (m *model) cmdAct(id, action, label string, body map[string]any) tea.Cmd {
	be := m.be
	return func() tea.Msg {
		res, err := be.Act(id, action, body)
		return actMsg{label: label, res: res, err: err, pin: action == "pair"}
	}
}

func (m *model) cmdDelete(id, label string) tea.Cmd {
	be := m.be
	return func() tea.Msg {
		res, err := be.Delete(id)
		return actMsg{label: label, res: res, err: err}
	}
}

// due: true when `key` hasn't been fetched for `every` and isn't being fetched now.
func (m *model) due(key string, every time.Duration) bool {
	if m.inflight[key] {
		return false
	}
	if time.Since(m.last[key]) < every {
		return false
	}
	m.last[key] = time.Now()
	return true
}

func (m *model) setNotice(s string, bad bool) {
	m.notice, m.noticeBad, m.noticeAt = s, bad, time.Now()
}

func (m *model) selected() *Machine {
	if m.sel >= 0 && m.sel < len(m.machines) {
		return &m.machines[m.sel]
	}
	return nil
}

// selectedLocal: the highlighted entry when it is one of your own PCs (they follow the cloud machines in the list).
func (m *model) selectedLocal() *LocalMachine {
	i := m.sel - len(m.machines)
	if i >= 0 && i < len(m.local) {
		return &m.local[i]
	}
	return nil
}

// entries: how many rows the Machines list has (cloud machines, then your own PCs).
func (m *model) entries() int { return len(m.machines) + len(m.local) }

func (m *model) clampSel() {
	if m.sel >= m.entries() {
		m.sel = max(0, m.entries()-1)
	}
}

func (m *model) anyBusy() bool {
	for _, x := range m.machines {
		if x.Busy() {
			return true
		}
	}
	return false
}

// ---- update ---------------------------------------------------------------------------

func (m *model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.w, m.h = msg.Width, msg.Height
		return m, nil
	case spinner.TickMsg:
		var c tea.Cmd
		m.spin, c = m.spin.Update(msg)
		return m, c
	case tickMsg:
		return m, tea.Batch(tick(), m.pollDue())
	case meMsg:
		if msg.err != nil {
			if errors.Is(msg.err, ErrUnauthorized) {
				m.cfg.Token = ""
				_ = saveConfig(m.cfg)
				m.authed = false
				return m, nil
			}
			m.err = msg.err.Error()
			return m, nil
		}
		m.user, m.authed, m.err = msg.u, true, ""
		return m, m.afterLogin()
	case loginMsg:
		m.login.busy = false
		if msg.err != nil {
			m.login.err = msg.err.Error()
			return m, nil
		}
		m.cfg.Token = msg.token
		if ts, ok := m.be.(interface{ SetToken(string) }); ok {
			ts.SetToken(msg.token)
		}
		_ = saveConfig(m.cfg)
		return m, m.checkMe()
	case statusMsg:
		m.inflight["status"] = false
		if msg.err == nil {
			m.status = msg.s
		}
		return m, nil
	case spendMsg:
		m.inflight["spend"] = false
		if msg.err == nil {
			m.spend = msg.s
		}
		return m, nil
	case machinesMsg:
		m.inflight["machines"] = false
		return m, m.onMachines(msg)
	case teleMsg:
		m.inflight["tele:"+msg.id] = false
		if msg.err != nil {
			if errors.Is(msg.err, ErrUnauthorized) {
				return m, m.signedOut()
			}
			m.teleErr[msg.id] = msg.err.Error()
			return m, nil
		}
		delete(m.teleErr, msg.id)
		if msg.local {
			m.localTele[msg.id] = msg.t
		} else {
			m.tele[msg.id] = msg.t
		}
		return m, nil
	case connMsg:
		m.inflight["conn:"+msg.id] = false
		if msg.err == nil {
			m.conn[msg.id] = msg.c
		}
		return m, nil
	case opsMsg:
		m.inflight["ops:"+msg.machineID] = false
		if msg.err == nil {
			if msg.machineID == "" {
				m.ops = msg.ops
				if m.opSel >= len(m.ops) {
					m.opSel = max(0, len(m.ops)-1)
				}
			} else {
				m.mops[msg.machineID] = msg.ops
			}
		}
		return m, nil
	case opMsg:
		if m.opv != nil {
			m.opv.inflight = false
			if msg.err == nil && msg.op != nil && msg.op.ID == m.opv.id {
				m.opv.add(msg.op)
			}
		}
		return m, nil
	case localMsg:
		m.inflight["local"] = false
		if msg.err == nil {
			m.local = msg.l
			m.clampSel()
		}
		return m, nil
	case invMsg:
		m.inflight["inv"] = false
		if msg.err == nil {
			m.inv = msg.inv
		}
		return m, nil
	case optionsMsg:
		m.inflight["options"] = false
		if msg.err != nil {
			m.setNotice("Couldn't load launch options: "+msg.err.Error(), true)
			if m.wiz != nil {
				m.wiz.loadErr = msg.err.Error()
			}
			return m, nil
		}
		m.options = msg.o
		if m.wiz != nil {
			m.wiz.start(msg.o)
		}
		return m, nil
	case costsMsg:
		m.inflight["costs"] = false
		m.costs = msg.d
		return m, nil
	case regionsMsg:
		m.inflight["regions"] = false
		m.regionsLoading = false
		if msg.err != nil {
			if errors.Is(msg.err, ErrUnauthorized) {
				return m, m.signedOut()
			}
			m.regionsErr = msg.err.Error()
			if msg.refresh {
				m.setNotice("Region check failed: "+msg.err.Error(), true)
			}
			return m, nil
		}
		m.regionsErr = ""
		m.regions = msg.r
		if msg.refresh {
			m.setNotice("Regions re-checked live.", false)
		}
		return m, nil
	case actMsg:
		return m, m.onAct(msg)
	case launchMsg:
		if m.wiz != nil {
			m.wiz.launching = false
		}
		if msg.err != nil {
			if m.wiz != nil {
				m.wiz.err = msg.err.Error()
			}
			return m, nil
		}
		m.wiz = nil
		m.screen = scrActivity
		m.setNotice("Launching: watch the log below. The machine appears on the Machines screen.", false)
		m.opv = newOpView(msg.opID)
		m.last["machines"] = time.Time{}
		return m, tea.Batch(m.cmdOps(""), m.cmdOp(msg.opID, 0), m.cmdMachines())
	case tea.KeyMsg:
		return m.onKey(msg)
	}
	return m, nil
}

func (m *model) signedOut() tea.Cmd {
	m.cfg.Token = ""
	_ = saveConfig(m.cfg)
	m.authed = false
	m.login = newLogin()
	m.login.err = "Your sign-in expired. Sign in again."
	return nil
}

func (m *model) afterLogin() tea.Cmd {
	return tea.Batch(m.cmdMachines(), m.cmdStatus(), m.cmdSpend(), m.cmdOps(""), m.cmdOptions())
}

func (m *model) onMachines(msg machinesMsg) tea.Cmd {
	if msg.err != nil {
		if errors.Is(msg.err, ErrUnauthorized) {
			return m.signedOut()
		}
		m.err = msg.err.Error()
		return nil
	}
	m.err = ""
	var keep string
	if s := m.selected(); s != nil {
		keep = s.ID
	}
	m.allMachines, m.loaded = msg.m, true
	m.applyMachineFilter()
	for i, x := range m.machines {
		if x.ID == keep {
			m.sel = i
		}
	}
	m.clampSel()
	return nil
}

func (m *model) onAct(msg actMsg) tea.Cmd {
	if msg.err != nil {
		if errors.Is(msg.err, ErrUnauthorized) {
			return m.signedOut()
		}
		m.setNotice(msg.label+" failed: "+msg.err.Error(), true)
		return nil
	}
	m.last["machines"] = time.Time{}
	m.last["ops:"] = time.Time{}
	if msg.pin {
		pin, _ := msg.res["pin"].(string)
		host, _ := msg.res["host"].(string)
		m.prompt = &prompt{kind: pInfo, title: "Pair Moonlight", body: fmt.Sprintf("1. On your Mac, run:\n\n   moonlight pair %s --pin %s\n\n2. GGGH types the PIN into Sunshine for you (it keeps trying for 3 minutes).\n\nOr open Moonlight, add %s, and use the PIN %s when it asks.", host, pin, host, pin)}
		return tea.Batch(m.cmdMachines(), m.cmdOps(""))
	}
	m.setNotice(msg.label+": requested. It shows on the Activity tab.", false)
	return tea.Batch(m.cmdMachines(), m.cmdOps(""))
}

// pollDue is the heartbeat: it starts whichever refreshes are due.
func (m *model) pollDue() tea.Cmd {
	if !m.authed {
		return nil
	}
	var cmds []tea.Cmd
	if m.notice != "" && time.Since(m.noticeAt) > 8*time.Second {
		m.notice = ""
	}
	every := 5 * time.Second
	if m.anyBusy() {
		every = 2 * time.Second
	}
	if m.due("machines", every) {
		m.inflight["machines"] = true
		cmds = append(cmds, m.cmdMachines())
	}
	if m.due("status", 20*time.Second) {
		m.inflight["status"] = true
		cmds = append(cmds, m.cmdStatus())
	}
	if m.due("spend", 60*time.Second) {
		m.inflight["spend"] = true
		cmds = append(cmds, m.cmdSpend())
	}
	if m.due("local", 10*time.Second) {
		m.inflight["local"] = true
		cmds = append(cmds, m.cmdLocal())
	}
	// teleFor: refresh one machine's telemetry when due
	teleFor := func(id string, local bool, every time.Duration) {
		if m.due("tele:"+id, every) {
			m.inflight["tele:"+id] = true
			cmds = append(cmds, m.cmdTele(id, local))
		}
	}
	switch m.screen {
	case scrDashboard, scrPerf:
		// everything that is on: its numbers feed the cards
		for _, x := range m.machines {
			if x.Status == "running" {
				teleFor(x.ID, false, 10*time.Second)
			}
		}
		for _, p := range m.local {
			if p.Online {
				teleFor(p.ID, true, 10*time.Second)
			}
		}
		if m.screen == scrDashboard {
			if m.due("inv", 60*time.Second) {
				m.inflight["inv"] = true
				cmds = append(cmds, m.cmdInv())
			}
			if m.due("ops:", 5*time.Second) {
				m.inflight["ops:"] = true
				cmds = append(cmds, m.cmdOps(""))
			}
		}
	case scrMachines:
		if p := m.selectedLocal(); p != nil && p.Online {
			teleFor(p.ID, true, 5*time.Second)
		}
		if s := m.selected(); s != nil {
			if s.Status == "running" {
				teleFor(s.ID, false, 5*time.Second) // also feeds the hardware cards
			}
			needConn := m.detail == tabConnect || s.Busy() || (s.Status == "running" && m.conn[s.ID] == nil)
			if (s.Status == "running" || s.Busy() || s.Status == "stopped") && needConn && m.due("conn:"+s.ID, 5*time.Second) {
				m.inflight["conn:"+s.ID] = true
				cmds = append(cmds, m.cmdConn(s.ID))
			}
			if m.detail == tabActivity && m.due("ops:"+s.ID, 4*time.Second) {
				m.inflight["ops:"+s.ID] = true
				cmds = append(cmds, m.cmdOps(s.ID))
			}
		}
	case scrActivity:
		if m.due("ops:", 4*time.Second) {
			m.inflight["ops:"] = true
			cmds = append(cmds, m.cmdOps(""))
		}
		if o := m.opv; o != nil && !o.inflight && !o.done && time.Since(o.fetched) > 1500*time.Millisecond {
			o.inflight, o.fetched = true, time.Now()
			cmds = append(cmds, m.cmdOp(o.id, o.after))
		}
	case scrCosts:
		if m.due("costs", 60*time.Second) {
			m.inflight["costs"] = true
			cmds = append(cmds, m.cmdCosts(false))
		}
	case scrRegions:
		if m.due("regions", 5*time.Minute) {
			m.inflight["regions"] = true
			cmds = append(cmds, m.cmdRegions(false))
		}
	}
	return tea.Batch(cmds...)
}

// refreshNow forgets when things were last fetched, so the next tick fetches them.
func (m *model) refreshNow() {
	m.last = map[string]time.Time{}
	m.setNotice("Refreshing…", false)
}

// ---- keys -----------------------------------------------------------------------------

func (m *model) onKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	if k.String() == "ctrl+c" {
		m.quitting = true
		return m, tea.Quit
	}
	if !m.authed {
		return m.loginKey(k)
	}
	if m.prompt != nil {
		return m.promptKey(k)
	}
	if m.help {
		m.help = false
		return m, nil
	}
	if m.screen == scrWizard && m.wiz != nil {
		return m.wizardKey(k)
	}
	if m.screen == scrActivity && m.opv != nil {
		return m.opViewKey(k)
	}
	switch k.String() {
	case "q":
		m.quitting = true
		return m, tea.Quit
	case "?":
		m.help = true
		return m, nil
	case "1":
		m.screen = scrDashboard
		m.last["inv"] = time.Time{}
		return m, nil
	case "2":
		m.screen = scrMachines
		return m, nil
	case "3":
		m.screen = scrPerf
		return m, nil
	case "4":
		m.screen = scrActivity
		m.last["ops:"] = time.Time{}
		return m, nil
	case "5":
		m.screen = scrCosts
		m.last["costs"] = time.Time{}
		return m, nil
	case "6":
		m.screen = scrRegions
		m.last["regions"] = time.Time{}
		return m, nil
	case "n":
		return m, m.openWizard()
	case "ctrl+r", "f5":
		m.refreshNow()
		return m, nil
	case "L":
		return m, m.confirm("Sign out?", "Your saved sign-in is removed from this Mac.", true, func(m *model, _ string) tea.Cmd {
			m.cfg.Token = ""
			if ts, ok := m.be.(interface{ SetToken(string) }); ok {
				ts.SetToken("")
			}
			_ = saveConfig(m.cfg)
			m.authed = false
			m.login = newLogin()
			return nil
		})
	}
	switch m.screen {
	case scrDashboard:
		return m.dashKey(k)
	case scrMachines:
		return m.machinesKey(k)
	case scrPerf:
		return m.perfKey(k)
	case scrActivity:
		return m.activityKey(k)
	case scrCosts:
		return m.costsKey(k)
	case scrRegions:
		return m.regionsKey(k)
	}
	return m, nil
}

func (m *model) costsKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch k.String() {
	case "up", "k":
		m.cvp.LineUp(1)
	case "down", "j":
		m.cvp.LineDown(1)
	case "pgup", "ctrl+u", "K":
		m.cvp.HalfViewUp()
	case "pgdown", "ctrl+d", "J":
		m.cvp.HalfViewDown()
	case "home", "g":
		m.cvp.GotoTop()
	case "r":
		m.last["costs"] = time.Time{}
		m.setNotice("Reloading costs…", false)
	case "R":
		m.setNotice("Asking each cloud for its latest bill and inventory (can take a minute)…", false)
		m.inflight["costs"] = true
		return m, m.cmdCosts(true)
	}
	return m, nil
}

func (m *model) applyMachineFilter() {
	m.failedCount = 0
	var shown []Machine
	for _, x := range m.allMachines {
		if x.Status == "failed" {
			m.failedCount++
			if !m.showFailed {
				continue
			}
		}
		shown = append(shown, x)
	}
	m.machines = shown
}

func (m *model) confirm(title, body string, danger bool, run func(m *model, val string) tea.Cmd) tea.Cmd {
	m.prompt = &prompt{kind: pConfirm, title: title, body: body, danger: danger, run: run}
	return nil
}

func (m *model) promptKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	p := m.prompt
	switch p.kind {
	case pInfo:
		switch k.String() {
		case "esc", "enter", "q", " ":
			m.prompt = nil
		}
		return m, nil
	case pConfirm:
		switch k.String() {
		case "y", "Y", "enter":
			m.prompt = nil
			if p.run != nil {
				return m, p.run(m, "")
			}
		case "n", "N", "esc", "q":
			m.prompt = nil
		}
		return m, nil
	default: // pInput
		switch k.String() {
		case "esc":
			m.prompt = nil
			return m, nil
		case "enter":
			m.prompt = nil
			if p.run != nil {
				return m, p.run(m, strings.TrimSpace(p.ti.Value()))
			}
			return m, nil
		}
		var c tea.Cmd
		p.ti, c = p.ti.Update(k)
		return m, c
	}
}

func (m *model) machinesKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	s := m.selected()
	if m.selectedLocal() != nil { // your own PCs: choose, scroll, change the window; no cloud actions apply
		switch k.String() {
		case "w":
			m.rangeIx = (m.rangeIx + 1) % len(teleRanges)
			m.last = dropKeys(m.last, "tele:")
			m.setNotice("Monitor window: "+teleRanges[m.rangeIx].label, false)
			return m, nil
		case "r":
			m.refreshNow()
			return m, nil
		case "f":
			// handled below like a cloud machine's filter toggle
		case "up", "k", "down", "j", "pgdown", "ctrl+d", "J", "pgup", "ctrl+u", "K":
			// handled below
		default:
			return m, nil
		}
	}
	switch k.String() {
	case "up", "k":
		if m.sel > 0 {
			m.sel--
			m.vp.GotoTop()
		}
	case "down", "j":
		if m.sel < m.entries()-1 {
			m.sel++
			m.vp.GotoTop()
		}
	case "right", "tab", "l":
		if m.selectedLocal() != nil {
			return m, nil
		}
		m.detail = (m.detail + 1) % 4
		m.vp.GotoTop()
		m.last = dropKeys(m.last, "conn:", "ops:", "tele:")
	case "left", "shift+tab", "h":
		m.detail = (m.detail + 3) % 4
		m.vp.GotoTop()
		m.last = dropKeys(m.last, "conn:", "ops:", "tele:")
	case "pgdown", "ctrl+d", "J":
		m.vp.HalfViewDown()
	case "pgup", "ctrl+u", "K":
		m.vp.HalfViewUp()
	case "w":
		m.rangeIx = (m.rangeIx + 1) % len(teleRanges)
		m.last = dropKeys(m.last, "tele:")
		m.setNotice("Monitor window: "+teleRanges[m.rangeIx].label, false)
	case "r":
		if s != nil && s.Status == "shelved" {
			return m, m.confirm("Restore "+s.Name()+"?", "Brings the shelved machine back from its snapshot (a few minutes) and starts it.", false,
				func(m *model, _ string) tea.Cmd { return m.cmdAct(s.ID, "restore", "Restore", nil) })
		}
		m.refreshNow()
	case "s":
		if s != nil && s.Status == "stopped" {
			id, name := s.ID, s.Name()
			return m, m.confirm("Start "+name+"?", fmt.Sprintf("Billing resumes at about %s/hour.", money(s.CostPerHour)), false,
				func(m *model, _ string) tea.Cmd { return m.cmdAct(id, "start", "Start", nil) })
		}
		if s != nil {
			m.setNotice("Start works on a stopped machine (this one is "+s.Status+").", true)
		}
	case "x":
		if s != nil && s.Status == "running" {
			id, name := s.ID, s.Name()
			return m, m.confirm("Stop "+name+"?", "Games and settings are kept. The disk stays billed; compute billing stops.", false,
				func(m *model, _ string) tea.Cmd {
					return m.cmdAct(id, "stop", "Stop", map[string]any{"snapshot": false})
				})
		}
		if s != nil {
			m.setNotice("Stop works on a running machine (this one is "+s.Status+").", true)
		}
	case "z":
		if s != nil && (s.Status == "running" || s.Status == "stopped") {
			id, name := s.ID, s.Name()
			return m, m.confirm("Shelve "+name+"?", "Takes a snapshot of the disk and DELETES the machine, so only the cheap snapshot is billed. Restore (r) brings it back with your games.", false,
				func(m *model, _ string) tea.Cmd { return m.cmdAct(id, "shelve", "Shelve", nil) })
		}
	case "D":
		if s != nil && !s.Busy() {
			id, name := s.ID, s.Name()
			return m, m.confirm("DELETE "+name+"?", "This permanently deletes the machine and its disk. It cannot be undone.", true,
				func(m *model, _ string) tea.Cmd { return m.cmdDelete(id, "Delete") })
		}
	case "u", "U":
		if s != nil && s.Status == "running" {
			id, restart := s.ID, k.String() == "U"
			body := "Writes the current on-machine setup script (Google Cloud machines). It takes effect at the machine's next boot."
			if restart {
				body += " The machine will restart now (games are untouched)."
			}
			return m, m.confirm("Update the script on "+s.Name()+"?", body, false,
				func(m *model, _ string) tea.Cmd {
					return m.cmdAct(id, "update-script", "Update script", map[string]any{"restart": restart})
				})
		}
	case "R":
		if s != nil && (s.Status == "running" || s.Status == "stopped") {
			id := s.ID
			return m, m.confirm("Resume setup on "+s.Name()+"?", "Restarts an unfinished setup (a stopped or stalled machine).", false,
				func(m *model, _ string) tea.Cmd { return m.cmdAct(id, "resume-setup", "Resume setup", nil) })
		}
	case "y":
		if s != nil {
			return m, m.cmdAct(s.ID, "sync", "Refresh", nil)
		}
	case "p":
		if s != nil && s.Status == "running" {
			return m, m.cmdAct(s.ID, "pair", "Pair", nil)
		}
		m.setNotice("Pairing needs a running machine.", true)
	case "e":
		if s != nil {
			id := s.ID
			ti := textinput.New()
			ti.SetValue(s.Nickname)
			ti.CharLimit = 40
			ti.Focus()
			m.prompt = &prompt{kind: pInput, title: "Rename (also what Moonlight lists)", ti: ti,
				run: func(m *model, v string) tea.Cmd {
					if v == "" {
						return nil
					}
					return m.cmdAct(id, "nickname", "Rename", map[string]any{"nickname": v})
				}}
		}
	case "$":
		if s != nil && s.Status != "creating" {
			id, to := s.ID, !s.Spot
			word := "spot (cheaper, can be reclaimed)"
			if !to {
				word = "on-demand (dearer, never reclaimed)"
			}
			return m, m.confirm("Switch to "+word+"?", "Applies to "+s.Name()+"; a running machine is stopped and restarted by the cloud as needed.", false,
				func(m *model, _ string) tea.Cmd {
					return m.cmdAct(id, "pricing", "Pricing", map[string]any{"spot": to})
				})
		}
	case "v":
		m.showPass = !m.showPass
	case "c":
		if s != nil {
			if c := m.conn[s.ID]; c != nil && c.Password != "" {
				copyText(c.Password)
				m.setNotice("Sunshine password copied to the clipboard.", false)
			}
		}
	case "C":
		if s != nil && s.IP != "" {
			copyText(s.IP)
			m.setNotice("IP "+s.IP+" copied to the clipboard.", false)
		}
	case "o":
		if s != nil {
			if c := m.conn[s.ID]; c != nil && c.SunshineURL != "" {
				openURL(c.SunshineURL)
				m.setNotice("Opened "+c.SunshineURL+" in your browser.", false)
			}
		}
	case "f":
		m.showFailed = !m.showFailed
		m.applyMachineFilter()
		m.clampSel()
		m.setNotice(map[bool]string{true: "Showing failed machines too.", false: "Failed machines hidden."}[m.showFailed], false)
	case "a":
		m.detail = tabActivity
	case "i":
		m.detail = tabInfo
	}
	return m, nil
}

func dropKeys(mp map[string]time.Time, prefixes ...string) map[string]time.Time {
	for k := range mp {
		for _, p := range prefixes {
			if strings.HasPrefix(k, p) {
				delete(mp, k)
			}
		}
	}
	return mp
}

func (m *model) activityKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch k.String() {
	case "up", "k":
		if m.opSel > 0 {
			m.opSel--
		}
	case "down", "j":
		if m.opSel < len(m.ops)-1 {
			m.opSel++
		}
	case "enter", "right", "l":
		if m.opSel < len(m.ops) {
			m.opv = newOpView(m.ops[m.opSel].ID)
			m.opv.title = m.ops[m.opSel].Title
			return m, m.cmdOp(m.opv.id, 0)
		}
	case "r":
		m.refreshNow()
	}
	return m, nil
}

func (m *model) opViewKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch k.String() {
	case "esc", "q", "left", "h", "backspace":
		m.opv = nil
		return m, nil
	case "2":
		m.opv, m.screen = nil, scrMachines
		return m, nil
	case "up", "k":
		m.opv.vp.LineUp(1)
	case "down", "j":
		m.opv.vp.LineDown(1)
	case "pgup", "ctrl+u":
		m.opv.vp.HalfViewUp()
	case "pgdown", "ctrl+d":
		m.opv.vp.HalfViewDown()
	case "G":
		m.opv.vp.GotoBottom()
	}
	return m, nil
}

// ---- helpers ------------------------------------------------------------------------------

func (m *model) bodyHeight() int {
	h := m.h - 3 - len(m.footerLines())
	if h < 6 {
		h = 6
	}
	return h
}

var _ = lipgloss.Width

var zeroTime time.Time
