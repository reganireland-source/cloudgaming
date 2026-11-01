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
	for i := 1; i <= 6; i++ {
		d.machines = append(d.machines, &demoMachine{Machine: Machine{ID: fmt.Sprintf("m-demo-f%d", i), Nickname: fmt.Sprintf("AWS-MUMBAI-L40S-SUPER-S-BS-%d", i), Provider: "aws", Region: "ap-south-1", InstanceType: "g6e.xlarge", Status: "failed", CostPerHour: 0.86, Spot: true, DiskSizeGb: 150, CreatedAt: iso(time.Duration(i) * 7 * time.Hour), LastError: map[string]any{"title": "No GPU quota in this region"}}})
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
		mk("n1-standard-4+t4", "T4 · 4 vCPU · 15 GB", "T4", 4, 15, false, 0.52, 0),
		mk("g2-standard-8", "L4 · 8 vCPU · 32 GB", "L4", 8, 32, false, 0.85, 0),
		mk("g2-standard-16", "L4 · 16 vCPU · 64 GB (DEV)", "L4", 16, 64, true, 1.30, 200),
		mk("g2-standard-32", "L4 · 32 vCPU · 128 GB (DEV)", "L4", 32, 128, true, 2.10, 300),
	}
	regs := []Region{{ID: "asia-southeast1", Name: "Singapore", GPUs: []string{"T4", "L4"}}, {ID: "us-central1", Name: "Iowa", GPUs: []string{"T4", "L4"}}, {ID: "us-east-1", Name: "N. Virginia", GPUs: []string{"T4", "L4"}}}
	o := &Options{
		Qualities: []string{"budget", "good", "high", "ultra"},
		Providers: []ProviderOpt{
			{Provider: "gcp", Label: "Google Cloud", Configured: true, Available: true, SupportsSpot: true, DefaultRegion: "asia-southeast1", DefaultDiskGb: 150, MinDiskGb: 50, DiskPerGbMo: 0.04, Regions: regs, Shapes: shapes},
			{Provider: "aws", Label: "AWS", Configured: true, Available: true, SupportsSpot: true, DefaultRegion: "us-east-1", DefaultDiskGb: 150, MinDiskGb: 50, DiskPerGbMo: 0.08, Regions: regs[2:], Shapes: []Shape{mk("g4dn.xlarge", "T4 · 4 vCPU · 16 GB", "T4", 4, 16, false, 0.53, 0), mk("g5.xlarge", "A10G · 4 vCPU · 16 GB", "L4", 4, 16, false, 0.78, 0)}},
			{Provider: "azure", Label: "Azure", Configured: false, Available: true, DefaultRegion: "us-east-1", DefaultDiskGb: 128, MinDiskGb: 50, DiskPerGbMo: 0.05, Regions: regs[2:], Shapes: []Shape{mk("Standard_NC4as_T4_v3", "T4 · 4 vCPU · 28 GB", "T4", 4, 28, false, 0.21, 0)}},
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

func (d *DemoBackend) AddLocalMachine(name string) (*NewLocalPC, error) {
	return &NewLocalPC{Machine: LocalMachine{ID: "l-demo-2", Name: name}}, nil
}

func titleCase(s string) string {
	if s == "" {
		return s
	}
	return string(s[0]-32) + s[1:]
}

// ---- costs, billing, regions and quotas (made up) ------------------------------------

func (d *DemoBackend) Inventory(refresh bool) (*Inventory, error) {
	inv := &Inventory{}
	inv.Totals.RunningMachines, inv.Totals.Hourly, inv.Totals.MonthlyStanding = 1, 0.85, 31.4
	inv.Totals.Orphans, inv.Totals.OrphanMonthly = 2, 9.6
	inv.ByCloud = map[string]struct {
		Label    string  `json:"label"`
		Machines int     `json:"machines"`
		Running  int     `json:"running"`
		Hourly   float64 `json:"hourly"`
		Monthly  float64 `json:"monthly"`
	}{
		"gcp":   {Label: "Google Cloud", Machines: 1, Running: 1, Hourly: 0.85, Monthly: 16.0},
		"aws":   {Label: "AWS", Machines: 1, Running: 0, Monthly: 12.0},
		"azure": {Label: "Azure", Machines: 0, Monthly: 3.4},
	}
	inv.Items = []InvItem{
		{Provider: "aws", Type: "disk", Name: "vol-0a1b2c (old test)", Region: "us-east-1", Status: "available", SizeGb: 100, MonthlyCost: 8, Orphan: true, OrphanReason: "Disk not attached to any machine"},
		{Provider: "azure", Type: "snapshot", Name: "snap-leftover-3", Region: "southcentralus", Status: "ready", SizeGb: 40, MonthlyCost: 1.6, Orphan: true, OrphanReason: "Snapshot the app has no record of"},
	}
	return inv, nil
}

func (d *DemoBackend) CostsDaily(days int) ([]CostDay, error) {
	var out []CostDay
	for i := days - 1; i >= 0; i-- {
		t := time.Now().AddDate(0, 0, -i)
		play := 0.0
		if i%4 != 0 {
			play = 0.8 + 3.2*math.Abs(math.Sin(float64(i)*0.9))
		}
		eg := play * 0.08
		st := 0.9 + float64(days-i)*0.012
		out = append(out, CostDay{Date: t.Format("2006-01-02"), Compute: flex(play), Egress: flex(eg), Storage: flex(st), Total: flex(play + eg + st)})
	}
	return out, nil
}

func (d *DemoBackend) CostsMonthly() (*CostsMonthly, error) {
	m := &CostsMonthly{Total: 41.3}
	add := func(p string, c, e, s float64) {
		m.Breakdown = append(m.Breakdown, struct {
			Provider string `json:"provider"`
			Compute  flex   `json:"compute"`
			Egress   flex   `json:"egress"`
			Storage  flex   `json:"storage"`
		}{p, flex(c), flex(e), flex(s)})
	}
	add("gcp", 22.4, 2.1, 4.9)
	add("aws", 6.2, 0.6, 3.8)
	add("azure", 0.8, 0.1, 0.4)
	return m, nil
}

func (d *DemoBackend) CostsActuals(refresh bool) (*Recon, error) {
	r := &Recon{Month: time.Now().Format("2006-01")}
	pf := func(v float64) *float64 { return &v }
	usd := func(v float64) *struct {
		Amount   float64  `json:"amount"`
		Currency string   `json:"currency"`
		Usd      *float64 `json:"usd"`
	} {
		return &struct {
			Amount   float64  `json:"amount"`
			Currency string   `json:"currency"`
			Usd      *float64 `json:"usd"`
		}{Amount: v, Currency: "USD", Usd: pf(v)}
	}
	r.Clouds = []ReconCloud{
		{Provider: "gcp", Label: "Google Cloud", Status: "ok", DataThrough: time.Now().AddDate(0, 0, -1).Format("2006-01-02"), Actual: usd(26.1), EstimateMonthUsd: 29.4, DifferenceUsd: pf(-3.3), DifferencePct: pf(-11.2)},
		{Provider: "aws", Label: "AWS", Status: "ok", DataThrough: time.Now().AddDate(0, 0, -1).Format("2006-01-02"), Actual: usd(11.9), EstimateMonthUsd: 10.6, DifferenceUsd: pf(1.3), DifferencePct: pf(12.3)},
		{Provider: "azure", Label: "Azure", Status: "needs-setup", EstimateMonthUsd: 1.3, Notes: []string{"Turn on cost access so Azure's real bill shows here."}},
		{Provider: "oracle", Label: "Oracle", Status: "not-connected"},
	}
	r.Forecast.SoFarUsd, r.Forecast.DailyRateUsd, r.Forecast.ProjectedUsd = 41.3, 2.6, 78
	r.Forecast.DaysElapsed, r.Forecast.DaysInMonth, r.Forecast.Basis = 16, 31, "mixed"
	return r, nil
}

func (d *DemoBackend) Invoices(refresh bool) ([]CloudInvoices, error) {
	a := func(v float64) *float64 { return &v }
	return []CloudInvoices{
		{Provider: "gcp", Label: "Google Cloud", Status: "ok", Invoices: []Invoice{{ID: "5001", Period: "2026-09", Amount: a(58.2), Currency: "USD", Status: "paid"}, {ID: "4901", Period: "2026-08", Amount: a(44.9), Currency: "USD", Status: "paid"}}},
		{Provider: "aws", Label: "AWS", Status: "ok", Invoices: []Invoice{{ID: "A-77", Period: "2026-09", Amount: a(21.4), Currency: "USD", Status: "paid"}}},
		{Provider: "azure", Label: "Azure", Status: "needs-setup"},
	}, nil
}

func (d *DemoBackend) RegionAccess(refresh bool) (*RegionAccessResp, error) {
	ok := true
	no := false
	mk := func(id, name, status, summary string, quotas ...QuotaLine) RegionAccess {
		r := RegionAccess{Region: id, Name: name, Status: status, Summary: summary, Quotas: quotas}
		if status == "ready" {
			r.SpotReady = &ok
		}
		r.Run = []RunRow{
			{Label: "Budget", Shape: "T4 · 4 vCPU", Cells: map[string]RunCell{"normal": {OK: &ok}, "spot": {OK: &ok}, "big": {NA: true}, "bigSpot": {NA: true}}},
			{Label: "Good", Shape: "L4 · 8 vCPU", Cells: map[string]RunCell{"normal": {OK: &ok}, "spot": {OK: &ok}, "big": {OK: &ok}, "bigSpot": {OK: &no, Why: "No spot quota left"}}},
			{Label: "Dev", Shape: "L4 · 16 vCPU", Cells: map[string]RunCell{"normal": {OK: &no, Why: "Needs 16 vCPU quota; you have 8"}, "spot": {OK: &no}, "big": {NA: true}, "bigSpot": {NA: true}}},
		}
		if status != "ready" {
			for i := range r.Run {
				for k, c := range r.Run[i].Cells {
					if !c.NA {
						r.Run[i].Cells[k] = RunCell{OK: &no, Why: summary}
					}
				}
			}
		}
		if len(quotas) > 0 {
			u := quotas[0].Used
			r.QuotaDetail = []QuotaDetail{{Key: "l4", Label: quotas[0].Label, Used: &u, Limit: quotas[0].Limit, Unit: quotas[0].Unit, Unlocks: []string{"Good · Normal", "Good · Spot"}}}
			if status == "no-quota" {
				r.QuotaDetail[0].Short = true
				r.QuotaDetail[0].Request = &struct {
					ConsoleURL   string `json:"consoleUrl"`
					ConsoleLabel string `json:"consoleLabel"`
					CLI          string `json:"cli"`
					Note         string `json:"note"`
				}{ConsoleURL: "https://console.cloud.google.com/iam-admin/quotas", ConsoleLabel: "Open Quotas", CLI: "gcloud alpha services quota update --service=compute.googleapis.com --consumer=projects/PROJECT --metric=compute.googleapis.com/gpus_all_regions --value=1"}
				r.Fix = &struct {
					Steps        []string `json:"steps"`
					ConsoleURL   string   `json:"consoleUrl"`
					ConsoleLabel string   `json:"consoleLabel"`
					CLI          string   `json:"cli"`
				}{Steps: []string{"Open the Quotas page for this project.", "Filter for NVIDIA L4 GPUs in this region.", "Request 1 GPU. Approval is usually quick."}, ConsoleURL: "https://console.cloud.google.com/iam-admin/quotas", ConsoleLabel: "Open Quotas", CLI: r.QuotaDetail[0].Request.CLI}
			}
		}
		return r
	}
	q := func(l string, lim, used float64) QuotaLine {
		return QuotaLine{Label: l, Limit: lim, Used: used, Unit: "GPUs"}
	}
	gcp := CloudAccess{Provider: "gcp", Label: "Google Cloud", Connected: true, CheckedAt: time.Now().UTC().Format(time.RFC3339), Regions: []RegionAccess{
		mk("asia-southeast1", "Singapore", "ready", "Ready: 1 of 1 L4 GPU in use", q("NVIDIA L4 GPUs", 1, 1)),
		mk("us-central1", "Iowa", "ready", "Ready", q("NVIDIA L4 GPUs", 2, 0)),
		mk("europe-west4", "Netherlands", "no-quota", "No GPU quota here yet", q("NVIDIA L4 GPUs", 0, 0)),
		mk("asia-northeast1", "Tokyo", "no-quota", "No GPU quota here yet", q("NVIDIA L4 GPUs", 0, 0)),
		mk("australia-southeast1", "Sydney", "not-offered", "Google doesn't sell L4 GPUs here"),
		mk("southamerica-east1", "São Paulo", "not-enabled", "Compute API isn't switched on for this region"),
	}}
	aws := CloudAccess{Provider: "aws", Label: "AWS", Connected: true, CheckedAt: time.Now().UTC().Format(time.RFC3339), Regions: []RegionAccess{
		mk("us-east-1", "N. Virginia", "ready", "Ready", q("G and VT on-demand vCPUs", 8, 0)),
		mk("ap-south-1", "Mumbai", "no-quota", "G and VT quota is 0 here", q("G and VT on-demand vCPUs", 0, 0)),
		mk("eu-west-1", "Ireland", "unknown", "Couldn't check: access denied"),
	}}
	azure := CloudAccess{Provider: "azure", Label: "Azure", Connected: false, Regions: []RegionAccess{
		mk("southcentralus", "Texas", "not-connected", "Connect Azure in the web app to check this region"),
	}}
	oracle := CloudAccess{Provider: "oracle", Label: "Oracle", Connected: false}
	return &RegionAccessResp{GeneratedAt: time.Now().UTC().Format(time.RFC3339), Clouds: []CloudAccess{gcp, aws, azure, oracle}}, nil
}
