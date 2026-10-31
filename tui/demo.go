package main

import (
	"fmt"
	"math"
	"math/rand"
	"sync"
	"time"
)

// DemoBackend is a made-up GGGH account that lives in memory, so you can try
// every screen and key with `gggh-tui --demo` without a cloud, a login or any cost.
type DemoBackend struct {
	mu       sync.Mutex
	machines []*demoMachine
	ops      []*demoOp
	nextOp   int
}

type demoMachine struct {
	Machine
	next      string    // status it is moving to
	at        time.Time // when it gets there
	startedAt time.Time
}

type demoStep struct {
	after time.Duration
	level string
	msg   string
}

type demoOp struct {
	OpSummary
	start time.Time
	steps []demoStep
}

func NewDemo() *DemoBackend {
	now := time.Now()
	iso := func(d time.Duration) string { return now.Add(-d).UTC().Format(time.RFC3339) }
	d := &DemoBackend{}
	two := 15.0
	d.machines = []*demoMachine{
		{Machine: Machine{ID: "m-demo-1", Nickname: "SCUDRACE-ADELAIDE-DEV", Provider: "gcp", Region: "asia-southeast1", InstanceType: "g2-standard-32", Status: "running", CostPerHour: 0.85, Quality: "high", Spot: true, DiskSizeGb: 300, IP: "136.110.60.97", CreatedAt: iso(30 * time.Hour), LastStarted: iso(68 * time.Minute), AutoStopMin: &two, Standing: &Standing{DiskGb: 300, DiskMonthly: 12}, Addons: []struct{ ID string }{{"dev-base"}, {"godot"}}}, startedAt: now.Add(-68 * time.Minute)},
		{Machine: Machine{ID: "m-demo-2", Nickname: "AWS-VIRGINIA-T4", Provider: "aws", Region: "us-east-1", InstanceType: "g4dn.xlarge", Status: "stopped", CostPerHour: 0.53, Quality: "good", DiskSizeGb: 150, CreatedAt: iso(9 * 24 * time.Hour), StoppedAt: iso(5 * time.Hour), AutoStopMin: &two, Standing: &Standing{DiskGb: 150, DiskMonthly: 12}}},
		{Machine: Machine{ID: "m-demo-3", Nickname: "AZURE-TEXAS-T4-S", Provider: "azure", Region: "southcentralus", InstanceType: "Standard_NC4as_T4_v3", Status: "shelved", CostPerHour: 0.21, Quality: "good", Spot: true, DiskSizeGb: 128, CreatedAt: iso(20 * 24 * time.Hour), ShelvedAt: iso(3 * 24 * time.Hour), Standing: &Standing{DiskGb: 128, DiskMonthly: 5, ShelfMonthly: func() *float64 { v := 1.9; return &v }()}}},
	}
	d.addOp("m-demo-1", "gcp", "start", "Start SCUDRACE-ADELAIDE-DEV", "succeeded", -68*time.Minute, []demoStep{{0, "info", "Starting the machine…"}, {3 * time.Second, "success", "Machine is running at 136.110.60.97."}})
	return d
}

func (d *DemoBackend) addOp(machineID, provider, action, title, status string, offset time.Duration, steps []demoStep) *demoOp {
	d.nextOp++
	o := &demoOp{OpSummary: OpSummary{ID: fmt.Sprintf("op-demo-%d", d.nextOp), MachineID: machineID, Provider: provider, Action: action, Title: title, Status: status}, start: time.Now().Add(offset), steps: steps}
	d.ops = append([]*demoOp{o}, d.ops...)
	return o
}

// advance moves machines whose change is due, and finishes operations.
func (d *DemoBackend) advance() {
	now := time.Now()
	keep := d.machines[:0]
	for _, m := range d.machines {
		if m.next != "" && now.After(m.at) {
			if m.next == "gone" {
				continue
			}
			m.Status, m.next = m.next, ""
			switch m.Status {
			case "running":
				m.startedAt = now
				m.IP = fmt.Sprintf("34.%d.%d.%d", 100+rand.Intn(100), rand.Intn(250), 1+rand.Intn(250))
				m.LastStarted = now.UTC().Format(time.RFC3339)
			case "stopped":
				m.StoppedAt = now.UTC().Format(time.RFC3339)
				m.IP = ""
			case "shelved":
				m.ShelvedAt = now.UTC().Format(time.RFC3339)
				m.IP = ""
			}
		}
		keep = append(keep, m)
	}
	d.machines = keep
	for _, o := range d.ops {
		if o.Status == "running" && len(o.steps) > 0 && now.Sub(o.start) >= o.steps[len(o.steps)-1].after {
			o.Status = "succeeded"
			o.FinishedAt = now.UTC().Format(time.RFC3339)
		}
		o.CreatedAt = o.start.UTC().Format(time.RFC3339)
		o.LastMessage = ""
		for _, s := range o.steps {
			if now.Sub(o.start) >= s.after {
				o.LastMessage = s.msg
			}
		}
	}
}

func (d *DemoBackend) find(id string) *demoMachine {
	for _, m := range d.machines {
		if m.ID == id {
			return m
		}
	}
	return nil
}

func (d *DemoBackend) Login(email, password string) (string, error) { return "demo-token", nil }
func (d *DemoBackend) Me() (*User, error) {
	return &User{ID: "demo", Email: "you@example.com", DisplayName: "Demo"}, nil
}

func (d *DemoBackend) Status() (*SystemStatus, error) {
	l := func(v float64) *float64 { return &v }
	return &SystemStatus{
		Backend:  Svc{Name: "Backend", Connected: true},
		Database: Svc{Name: "Database", Connected: true, LatencyMs: l(3 + rand.Float64()*4)},
		Providers: map[string]Svc{
			"aws":    {Name: "AWS", Connected: true, LatencyMs: l(40 + rand.Float64()*20)},
			"azure":  {Name: "Azure", Connected: true, LatencyMs: l(60 + rand.Float64()*20)},
			"gcp":    {Name: "GCP", Connected: true, LatencyMs: l(25 + rand.Float64()*20)},
			"oracle": {Name: "Oracle", Connected: false},
		},
	}, nil
}

func (d *DemoBackend) Spend() (*Spend, error) {
	return &Spend{Today: SpendPart{Usd: 1.12, BilledUsd: 0}, WeekToDate: SpendPart{Usd: 6.8, BilledUsd: 5.9}, MonthToDate: SpendPart{Usd: 41.3, BilledUsd: 38.0}, ProjectedMonthUsd: 78}, nil
}

func (d *DemoBackend) Machines() ([]Machine, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.advance()
	out := make([]Machine, len(d.machines))
	for i, m := range d.machines {
		out[i] = m.Machine
		if m.next != "" && m.Status != "running" && !m.Busy() {
			out[i].Status = m.Status
		}
	}
	return out, nil
}

func (d *DemoBackend) Options() (*Options, error) {
	mk := func(id, label, gpu string, v int, mem float64, dev bool, od float64, disk float64) Shape {
		sp := od / 3
		return Shape{ID: id, Label: label, GPUModel: gpu, VCPUs: v, MemoryGb: mem, Dev: dev, DefaultDiskGb: disk, BestFor: "Demo size",
			Prices: map[string]Price{"asia-southeast1": {OnDemand: od, Spot: &sp}, "us-east-1": {OnDemand: od, Spot: &sp}, "us-central1": {OnDemand: od, Spot: &sp}}}
	}
	shapes := []Shape{
		mk("t4-4", "T4 · 4 vCPU · 15 GB", "T4", 4, 15, false, 0.52, 0),
		mk("l4-8", "L4 · 8 vCPU · 32 GB", "L4", 8, 32, false, 0.85, 0),
		mk("l4-16", "L4 · 16 vCPU · 64 GB (DEV)", "L4", 16, 64, true, 1.30, 200),
		mk("l4-32", "L4 · 32 vCPU · 128 GB (DEV)", "L4", 32, 128, true, 2.10, 300),
	}
	regs := []Region{{ID: "asia-southeast1", Name: "Singapore", GPUs: []string{"T4", "L4"}}, {ID: "us-central1", Name: "Iowa", GPUs: []string{"T4", "L4"}}, {ID: "us-east-1", Name: "N. Virginia", GPUs: []string{"T4", "L4"}}}
	o := &Options{
		Qualities: []string{"budget", "good", "high", "ultra"},
		Providers: []ProviderOpt{
			{Provider: "gcp", Label: "Google Cloud", Configured: true, Available: true, SupportsSpot: true, DefaultRegion: "asia-southeast1", DefaultDiskGb: 150, MinDiskGb: 50, DiskPerGbMo: 0.04, Regions: regs, Shapes: shapes},
			{Provider: "aws", Label: "AWS", Configured: true, Available: true, SupportsSpot: true, DefaultRegion: "us-east-1", DefaultDiskGb: 150, MinDiskGb: 50, DiskPerGbMo: 0.08, Regions: regs[2:], Shapes: shapes[:2]},
			{Provider: "azure", Label: "Azure", Configured: false, Available: true, DefaultRegion: "us-east-1", DefaultDiskGb: 128, MinDiskGb: 50, DiskPerGbMo: 0.05, Regions: regs[2:], Shapes: shapes[:1]},
			{Provider: "oracle", Label: "Oracle", Configured: false, Available: false},
		},
	}
	o.Purposes = demoPurposes()
	for _, a := range []AddonInfo{
		{ID: "dev-base", Name: "Developer basics", Description: "git, git-lfs, build tools, a dev login", DiskGb: 2},
		{ID: "python", Name: "Python environment", Description: "Python 3 and a shared venv", DiskGb: 1, Requires: []string{"dev-base"}},
		{ID: "node", Name: "Node.js", Description: "Node and npm", DiskGb: 1},
		{ID: "github-cli", Name: "GitHub CLI", Description: "gh", DiskGb: 0.1},
		{ID: "headless-gpu", Name: "Headless graphics runtime", Description: "Xvfb, Vulkan tools", DiskGb: 1},
		{ID: "godot", Name: "Godot (headless)", Description: "Godot engine", DiskGb: 0.3, Requires: []string{"dev-base", "headless-gpu"}},
		{ID: "wine", Name: "Wine + DXVK", Description: "Run Windows builds", DiskGb: 3, Requires: []string{"dev-base", "headless-gpu"}},
		{ID: "blender", Name: "Blender (headless)", Description: "Scripted model work", DiskGb: 1.5},
		{ID: "unity", Name: "Unity Editor", Description: "Experimental; you activate the licence", DiskGb: 30, Experimental: true, Requires: []string{"dev-base"}},
		{ID: "claude-code", Name: "Claude Code (CLI)", Description: "You sign in on the machine", DiskGb: 0.5, Requires: []string{"node"}},
		{ID: "google-drive", Name: "Google Drive (rclone)", Description: "gdrive-mount command", DiskGb: 0.2, Requires: []string{"dev-base"}},
	} {
		o.AddonCatalog.Addons = append(o.AddonCatalog.Addons, a)
	}
	return o, nil
}

func demoPurposes() []Purpose {
	mk := func(id, name, blurb string, minV int, minM float64, dev bool, disk float64, addons []string, toggles ...PurposeToggle) Purpose {
		p := Purpose{ID: id, Name: name, Blurb: blurb, DiskGb: disk, Addons: addons, Toggles: toggles}
		p.Size.MinVcpus, p.Size.MinMemoryGb, p.Size.DevTier = minV, minM, dev
		return p
	}
	return []Purpose{
		mk("play", "Play games", "A gaming PC you stream to. Nothing extra installed.", 0, 0, false, 0, nil),
		mk("gamedev", "Game development & testing", "Build, run headless tests, smoke-test Windows builds.", 8, 0, true, 200, []string{"dev-base", "github-cli", "headless-gpu"},
			PurposeToggle{ID: "godot", Label: "Godot", Default: true, Addons: []string{"godot"}}, PurposeToggle{ID: "wine", Label: "Wine + DXVK", Default: true, Addons: []string{"wine"}}, PurposeToggle{ID: "python", Label: "Python tools", Default: true, Addons: []string{"python"}}),
		mk("unity", "Unity builds", "Unity Editor for command-line builds (experimental).", 8, 32, true, 300, []string{"dev-base", "github-cli", "headless-gpu", "unity"}),
		mk("dev", "General development", "Compilers, git, Python and Node.", 4, 0, false, 100, []string{"dev-base", "github-cli"},
			PurposeToggle{ID: "python", Label: "Python", Default: true, Addons: []string{"python"}}, PurposeToggle{ID: "node", Label: "Node.js", Default: true, Addons: []string{"node"}}),
		mk("content", "3D & media processing", "Blender, ffmpeg and Python.", 4, 0, false, 150, []string{"dev-base", "blender"}),
	}
}

func fptr(v float64) *float64 { return &v }

func (d *DemoBackend) Telemetry(local bool, id string, minutes int) (*Telemetry, error) {
	d.mu.Lock()
	m := d.find(id)
	d.mu.Unlock()
	if !local && (m == nil || m.Status != "running") {
		return &Telemetry{Note: "Start the machine to see live telemetry."}, nil
	}
	n := 60
	now := time.Now().Unix()
	step := int64(minutes*60) / int64(n)
	if step < 15 {
		step = 15
	}
	t := &Telemetry{}
	for i := 0; i < n; i++ {
		ts := now - int64(n-1-i)*step
		x := float64(i)
		wave := func(base, amp, per float64) float64 { return base + amp*math.Sin(x/per) + rand.Float64()*amp/4 }
		s := Sample{T: ts, C: fptr(wave(14, 6, 5)), CM: fptr(30), L: fptr(1.4), M: []float64{wave(5.2, .3, 9), 125.8}, D: []float64{207 + x/30, 291},
			DR: fptr(wave(2, 2, 4)), DW: fptr(wave(3, 2, 3)), NI: fptr(wave(1, 1, 6)), NO: fptr(wave(34, 12, 4)), UP: fptr(4080 + x*float64(step)),
			CC: []float64{wave(86, 10, 7), 32}, CS: fptr(0.5), CW: fptr(0.2), PR: []*float64{fptr(2), fptr(0), fptr(1.5)}, DL: []*float64{fptr(0.8), fptr(1.4), fptr(0)},
			NE: []float64{0, 0, 0}, TX: fptr(3 + x/12), RT: &struct {
				R *float64 `json:"r"`
				J *float64 `json:"j"`
				L *float64 `json:"l"`
				O int      `json:"o"`
			}{R: fptr(wave(13, 3, 4)), J: fptr(1.8), L: fptr(0)}}
		if i == n-1 {
			s.NE = []float64{9, 3, 0}
		}
		s.G = map[string]any{"u": wave(45, 15, 3), "um": 70.0, "tp": wave(54, 3, 8), "pw": wave(40, 6, 4), "pl": 72.0, "vu": wave(4300, 300, 6), "vt": 22528.0, "cl": 2040.0, "cx": 2040.0, "es": 1.0, "ef": 60.0, "el": 4200.0, "ps": "P0", "eu": 18.0, "lg": 4.0, "lx": 4.0, "lw": 16.0, "lm": 16.0}
		s.GF = &struct {
			N  string   `json:"n"`
			F  *float64 `json:"f"`
			Lo *float64 `json:"lo"`
			Ft *float64 `json:"ft"`
			P1 *float64 `json:"p1"`
			Sc *float64 `json:"sc"`
		}{N: "ScudRaceBench.x86_64", F: fptr(wave(160, 25, 3)), Lo: fptr(110), Ft: fptr(14), P1: fptr(98), Sc: fptr(1)}
		s.P = [][]string{{"Xorg", "9.8"}, {"kasmxproxy", "5.9"}, {"Xkasmvnc", "3.9"}}
		s.GP = [][]any{{"ScudRaceBench.x86_64", 2048.0, 37.0}, {"Xorg", 300.0, 2.0}}
		s.K = []string{"cloudy: Up 1 hour (healthy)", "mlweb: Up 1 hour"}
		s.SS = &struct {
			B *float64 `json:"b"`
			E string   `json:"e"`
			D string   `json:"d"`
			R string   `json:"r"`
			F *float64 `json:"f"`
		}{B: fptr(40), E: "hevc_nvenc", D: "8", R: "2560x1440", F: fptr(60)}
		if local {
			s.GF, s.PR, s.CS, s.CW, s.SS, s.K, s.CM, s.L = nil, nil, nil, nil, nil, nil, nil, nil
		}
		t.Samples = append(t.Samples, s)
	}
	t.Latest = &t.Samples[len(t.Samples)-1]
	if local {
		t.Alerts = []Alert{{Level: "info", Key: "demo", Text: "This is a demo PC: the numbers are made up."}}
		return t, nil
	}
	t.EgressPerGb = fptr(0.12)
	t.Usage = &Usage{RunningMin: 68, StreamingMin: 12, IdleMin: 3, EverStreamed: true, AutoStopMin: fptr(15), CostPerHour: fptr(m.CostPerHour)}
	t.DiskFullDay = fptr(9.5)
	t.Alerts = []Alert{
		{Level: "info", Key: "bottleneck", Text: "ScudRaceBench.x86_64 is CPU-bound: one core is at 96% (the CPU is only 14% overall); a faster core would help more than more cores"},
		{Level: "warning", Key: "neterr", Text: "Network trouble on the machine: 9 errors, 3 dropped packets and 0 UDP errors in the last 15 s"},
	}
	return t, nil
}

func (d *DemoBackend) Connection(id string) (*Connection, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	m := d.find(id)
	if m == nil {
		return nil, &APIError{Status: 404, Msg: "Machine not found."}
	}
	c := &Connection{Status: m.Status, IP: m.IP, Username: "gamer", Password: "demo-Pass-1234"}
	if m.IP != "" {
		c.SunshineURL = "https://" + m.IP + ":47990"
		c.Browser.Desktop.URL = "https://" + m.IP + ":6901/?resize=scale"
		c.Browser.Play.URL = "https://" + m.IP + ":8080/"
	}
	names := []string{"Machine booted, starting setup", "Installing NVIDIA driver 590.48.01", "Installing Docker", "Downloading the streaming container", "Starting Sunshine, desktop and Steam", "Waiting for Sunshine to report healthy", "Ready to stream"}
	pcts := []float64{5, 20, 45, 65, 75, 85, 100}
	cut := len(names)
	if m.Busy() {
		cut = 3 + int(time.Since(m.at.Add(-6*time.Second)).Seconds())/2
		if cut > len(names)-1 {
			cut = len(names) - 1
		}
		if cut < 1 {
			cut = 1
		}
	}
	if m.Status == "running" || m.Status == "stopped" || m.Busy() {
		for i := 0; i < cut; i++ {
			c.Setup.Stages = append(c.Setup.Stages, Stage{Percent: pcts[i], Key: fmt.Sprint(i), Message: names[i]})
		}
		last := c.Setup.Stages[len(c.Setup.Stages)-1]
		c.Setup.Current = &last
		c.Setup.Ready = m.Status == "running" && cut == len(names)
	}
	return c, nil
}

func (d *DemoBackend) Act(id, action string, body map[string]any) (map[string]any, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.advance()
	m := d.find(id)
	if m == nil {
		return nil, &APIError{Status: 404, Msg: "Machine not found."}
	}
	schedule := func(busy, final string, after time.Duration, steps []demoStep) map[string]any {
		m.Status, m.next, m.at = busy, final, time.Now().Add(after)
		o := d.addOp(m.ID, m.Provider, action, fmt.Sprintf("%s %s", titleCase(action), m.Name()), "running", 0, steps)
		return map[string]any{"operationId": o.ID}
	}
	switch action {
	case "start":
		if m.Status != "stopped" {
			return nil, &APIError{Status: 409, Msg: "Only a stopped machine can be started.", Tip: "Its status is " + m.Status + "."}
		}
		return schedule("starting", "running", 5*time.Second, []demoStep{{0, "info", "Starting the machine…"}, {2 * time.Second, "info", "The cloud accepted the request."}, {5 * time.Second, "success", "Machine is running."}}), nil
	case "stop":
		if m.Status != "running" {
			return nil, &APIError{Status: 409, Msg: "Only a running machine can be stopped."}
		}
		return schedule("stopping", "stopped", 4*time.Second, []demoStep{{0, "info", "Stopping (games and settings are kept)…"}, {4 * time.Second, "success", "Stopped. The disk is still billed."}}), nil
	case "shelve":
		return schedule("shelving", "shelved", 6*time.Second, []demoStep{{0, "info", "Snapshotting the disk…"}, {3 * time.Second, "info", "Snapshot complete; deleting the machine…"}, {6 * time.Second, "success", "Shelved."}}), nil
	case "restore":
		if m.Status != "shelved" {
			return nil, &APIError{Status: 409, Msg: "Only a shelved machine can be restored."}
		}
		return schedule("restoring", "running", 6*time.Second, []demoStep{{0, "info", "Creating a disk from the snapshot…"}, {6 * time.Second, "success", "Restored and running."}}), nil
	case "sync", "update-script", "resume-setup":
		o := d.addOp(m.ID, m.Provider, action, titleCase(action)+" "+m.Name(), "running", 0, []demoStep{{0, "info", "Working…"}, {3 * time.Second, "success", "Done."}})
		return map[string]any{"operationId": o.ID}, nil
	case "pair":
		o := d.addOp(m.ID, m.Provider, action, "Pair Moonlight with "+m.IP, "running", 0, []demoStep{{0, "info", "Waiting for Moonlight to ask for the PIN…"}, {8 * time.Second, "success", "Paired."}})
		return map[string]any{"operationId": o.ID, "pin": "4821", "host": m.IP}, nil
	case "nickname":
		if s, ok := body["nickname"].(string); ok && s != "" {
			m.Nickname = s
		}
		return map[string]any{"nickname": m.Nickname}, nil
	case "pricing":
		if v, ok := body["spot"].(bool); ok {
			m.Spot = v
		}
		return map[string]any{}, nil
	case "quality":
		if v, ok := body["quality"].(string); ok {
			m.Quality = v
		}
		return map[string]any{"status": "quality_updated"}, nil
	}
	return nil, &APIError{Status: 400, Msg: "Unknown action " + action}
}

func (d *DemoBackend) Delete(id string) (map[string]any, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	m := d.find(id)
	if m == nil {
		return nil, &APIError{Status: 404, Msg: "Machine not found."}
	}
	m.Status, m.next, m.at = "deleting", "gone", time.Now().Add(3*time.Second)
	o := d.addOp(m.ID, m.Provider, "delete", "Delete "+m.Name(), "running", 0, []demoStep{{0, "info", "Deleting…"}, {3 * time.Second, "success", "Deleted."}})
	return map[string]any{"operationId": o.ID}, nil
}

func (d *DemoBackend) Launch(req LaunchReq) (string, string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	id := fmt.Sprintf("m-demo-%d", len(d.machines)+10+rand.Intn(1000))
	name := req.Nickname
	if name == "" {
		name = fmt.Sprintf("%s-%s-NEW", req.Provider, req.Region)
	}
	var addons []struct{ ID string }
	for _, a := range req.Addons {
		addons = append(addons, struct{ ID string }{a.ID})
	}
	m := &demoMachine{Machine: Machine{ID: id, Nickname: name, Provider: req.Provider, Region: req.Region, InstanceType: req.ShapeID, Status: "creating", CostPerHour: 0.9, Spot: req.Spot, DiskSizeGb: float64(req.DiskSizeGb), Addons: addons, CreatedAt: time.Now().UTC().Format(time.RFC3339), Standing: &Standing{DiskGb: float64(req.DiskSizeGb), DiskMonthly: float64(req.DiskSizeGb) * 0.04}}, next: "running", at: time.Now().Add(8 * time.Second)}
	d.machines = append([]*demoMachine{m}, d.machines...)
	o := d.addOp(id, req.Provider, "launch", "Launch "+name, "running", 0, []demoStep{
		{0, "info", "Loading your encrypted cloud credentials…"}, {2 * time.Second, "info", "Creating the machine…"},
		{5 * time.Second, "info", "The machine is installing the GPU driver, desktop and Sunshine by itself."}, {8 * time.Second, "success", "Machine is running."}})
	return id, o.ID, nil
}

func (d *DemoBackend) Operations(limit int, machineID string) ([]OpSummary, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.advance()
	var out []OpSummary
	for _, o := range d.ops {
		if machineID == "" || o.MachineID == machineID {
			out = append(out, o.OpSummary)
		}
	}
	return out, nil
}

func (d *DemoBackend) Operation(id string, after int) (*Operation, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.advance()
	for _, o := range d.ops {
		if o.ID != id {
			continue
		}
		op := &Operation{OpSummary: o.OpSummary}
		for i, s := range o.steps {
			if time.Since(o.start) >= s.after && i+1 > after {
				op.Events = append(op.Events, OpEvent{ID: i + 1, Level: s.level, Message: s.msg, At: o.start.Add(s.after).UTC().Format(time.RFC3339)})
			}
		}
		return op, nil
	}
	return nil, &APIError{Status: 404, Msg: "Operation not found."}
}

func (d *DemoBackend) LocalMachines() ([]LocalMachine, error) {
	return []LocalMachine{{ID: "l-demo-1", Name: "Big Gaming PC", LanIP: "192.168.1.157", Online: true, LastSeenAt: time.Now().UTC().Format(time.RFC3339),
		Status: map[string]any{"sunshine": "Running", "streaming": false, "wired": true, "link": "1000 Mbit/s", "gpu": map[string]any{"name": "RTX 4070", "util": 1.0, "tempC": 51.0}}}}, nil
}

func titleCase(s string) string {
	if s == "" {
		return s
	}
	return string(s[0]-32) + s[1:]
}
