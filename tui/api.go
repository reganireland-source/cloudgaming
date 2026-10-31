package main

import (
	"errors"
	"fmt"
	"strings"
)

// ---------------------------------------------------------------------------
// The shapes the GGGH backend (src/api/routes/*.ts) sends. Only the fields the
// TUI shows are listed; everything is optional so an older or newer backend
// never breaks decoding.
// ---------------------------------------------------------------------------

type User struct {
	ID          string `json:"id"`
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
}

type Svc struct {
	Name      string   `json:"name"`
	Connected bool     `json:"connected"`
	LatencyMs *float64 `json:"latencyMs"`
	Detail    string   `json:"detail"`
}

type SystemStatus struct {
	Backend   Svc            `json:"backend"`
	Database  Svc            `json:"database"`
	Providers map[string]Svc `json:"providers"`
}

type SpendPart struct {
	Usd       float64 `json:"usd"`
	BilledUsd float64 `json:"billedUsd"`
}

type Spend struct {
	Today             SpendPart `json:"today"`
	WeekToDate        SpendPart `json:"weekToDate"`
	MonthToDate       SpendPart `json:"monthToDate"`
	ProjectedMonthUsd float64   `json:"projectedMonthUsd"`
}

type Standing struct {
	DiskGb       float64  `json:"diskGb"`
	DiskMonthly  float64  `json:"diskMonthly"`
	ShelfMonthly *float64 `json:"shelfMonthly"`
}

type Machine struct {
	ID             string                `json:"id"`
	Nickname       string                `json:"nickname"`
	Provider       string                `json:"provider"`
	Region         string                `json:"region"`
	InstanceType   string                `json:"instance_type"`
	Status         string                `json:"status"`
	CostPerHour    float64               `json:"cost_per_hour"`
	Quality        string                `json:"streaming_quality"`
	GameTitle      string                `json:"game_title"`
	Spot           bool                  `json:"spot"`
	DiskSizeGb     float64               `json:"disk_size_gb"`
	IP             string                `json:"ip_address"`
	LastError      map[string]any        `json:"last_error"`
	CreatedAt      string                `json:"created_at"`
	LastStarted    string                `json:"last_started"`
	StoppedAt      string                `json:"stopped_at"`
	ShelvedAt      string                `json:"shelved_at"`
	AutoStopMin    *float64              `json:"auto_stop_minutes"`
	AutoShelveDays *float64              `json:"auto_shelve_days"`
	DisplayDriver  string                `json:"display_driver"`
	Addons         []struct{ ID string } `json:"addons"`
	Standing       *Standing             `json:"standing"`
}

func (m Machine) Name() string {
	if m.Nickname != "" {
		return m.Nickname
	}
	return m.InstanceType
}

// Busy: the status is changing by itself, so poll faster and offer no actions.
func (m Machine) Busy() bool {
	switch m.Status {
	case "creating", "starting", "stopping", "deleting", "shelving", "restoring":
		return true
	}
	return false
}

func (m Machine) ErrorTitle() string {
	if m.LastError == nil {
		return ""
	}
	for _, k := range []string{"title", "message", "error"} {
		if s, ok := m.LastError[k].(string); ok && s != "" {
			return s
		}
	}
	return "an error (see the web app for details)"
}

// ---- launch options --------------------------------------------------------

type Region struct {
	ID   string   `json:"id"`
	Name string   `json:"name"`
	GPUs []string `json:"gpus"`
}

type Price struct {
	OnDemand float64  `json:"onDemand"`
	Spot     *float64 `json:"spot"`
}

type Shape struct {
	ID            string           `json:"id"`
	Label         string           `json:"label"`
	GPUModel      string           `json:"gpuModel"`
	VCPUs         int              `json:"vcpus"`
	MemoryGb      float64          `json:"memoryGb"`
	BestFor       string           `json:"bestFor"`
	Dev           bool             `json:"dev"`
	AlsoDev       bool             `json:"alsoDev"`
	DefaultDiskGb float64          `json:"defaultDiskGb"`
	Prices        map[string]Price `json:"prices"`
}

type ProviderOpt struct {
	Provider      string   `json:"provider"`
	Label         string   `json:"label"`
	Configured    bool     `json:"configured"`
	Available     bool     `json:"available"`
	SupportsSpot  bool     `json:"supportsSpot"`
	DefaultRegion string   `json:"defaultRegion"`
	DefaultDiskGb float64  `json:"defaultDiskGb"`
	MinDiskGb     float64  `json:"minDiskGb"`
	DiskPerGbMo   float64  `json:"diskPerGbMonth"`
	Regions       []Region `json:"regions"`
	Shapes        []Shape  `json:"shapes"`
}

type AddonOption struct {
	Key, Label, Default string
}

type AddonInfo struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	DiskGb       float64  `json:"diskGb"`
	Requires     []string `json:"requires"`
	Experimental bool     `json:"experimental"`
}

type PurposeToggle struct {
	ID      string   `json:"id"`
	Label   string   `json:"label"`
	Default bool     `json:"default"`
	Addons  []string `json:"addons"`
}

type Purpose struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Blurb string `json:"blurb"`
	Size  struct {
		MinVcpus    int     `json:"minVcpus"`
		MinMemoryGb float64 `json:"minMemoryGb"`
		DevTier     bool    `json:"devTier"`
	} `json:"size"`
	DiskGb  float64         `json:"diskGb"`
	Addons  []string        `json:"addons"`
	Toggles []PurposeToggle `json:"toggles"`
	Quality string          `json:"quality"`
}

type Options struct {
	Providers    []ProviderOpt `json:"providers"`
	Qualities    []string      `json:"qualities"`
	Purposes     []Purpose     `json:"purposes"`
	AddonCatalog struct {
		Addons []AddonInfo `json:"addons"`
	} `json:"addonCatalog"`
}

type LaunchReq struct {
	Provider        string         `json:"provider"`
	Region          string         `json:"region"`
	ShapeID         string         `json:"shapeId"`
	DiskSizeGb      int            `json:"diskSizeGb"`
	Spot            bool           `json:"spot"`
	Quality         string         `json:"quality,omitempty"`
	AutoStopMinutes int            `json:"autoStopMinutes"`
	AutoShelveDays  *int           `json:"autoShelveDays"`
	Nickname        string         `json:"nickname,omitempty"`
	Addons          []AddonRequest `json:"addons"`
}

type AddonRequest struct {
	ID string `json:"id"`
}

// ---- telemetry (the shared sample, see src/providers/shared/setupScript.ts) -

type Sample struct {
	T  int64          `json:"t"`
	C  *float64       `json:"c"`
	CM *float64       `json:"cm"`
	L  *float64       `json:"l"`
	M  []float64      `json:"m"`
	Sw *float64       `json:"sw"`
	D  []float64      `json:"d"`
	DR *float64       `json:"dr"`
	DW *float64       `json:"dw"`
	NI *float64       `json:"ni"`
	NO *float64       `json:"no"`
	G  map[string]any `json:"g"`
	GF *struct {
		N  string   `json:"n"`
		F  *float64 `json:"f"`
		Lo *float64 `json:"lo"`
		Ft *float64 `json:"ft"`
		P1 *float64 `json:"p1"`
		Sc *float64 `json:"sc"`
	} `json:"gf"`
	CT *float64   `json:"ct"`
	UP *float64   `json:"up"`
	X  int        `json:"x"`
	XL string     `json:"xl"`
	O  int        `json:"o"`
	F  []string   `json:"f"`
	K  []string   `json:"k"`
	P  [][]string `json:"p"`
	CC []float64  `json:"cc"`
	CS *float64   `json:"cs"`
	CW *float64   `json:"cw"`
	PR []*float64 `json:"pr"`
	DL []*float64 `json:"dl"`
	NE []float64  `json:"ne"`
	TX *float64   `json:"tx"`
	RT *struct {
		R *float64 `json:"r"`
		J *float64 `json:"j"`
		L *float64 `json:"l"`
		O int      `json:"o"`
	} `json:"rt"`
	GP [][]any `json:"gp"`
	SS *struct {
		B *float64 `json:"b"`
		E string   `json:"e"`
		D string   `json:"d"`
		R string   `json:"r"`
		F *float64 `json:"f"`
	} `json:"ss"`
	SP string `json:"sp"`
	SN *struct {
		E []string `json:"e"`
		X int      `json:"x"`
	} `json:"sn"`
}

// gnum / gstr read the GPU map's mixed number-and-text values.
func (s *Sample) gnum(k string) (float64, bool) {
	if s == nil || s.G == nil {
		return 0, false
	}
	v, ok := s.G[k].(float64)
	return v, ok
}

func (s *Sample) gstr(k string) string {
	if s == nil || s.G == nil {
		return ""
	}
	v, _ := s.G[k].(string)
	return v
}

type Alert struct {
	Level string `json:"level"`
	Key   string `json:"key"`
	Text  string `json:"text"`
}

type Usage struct {
	RunningMin   float64  `json:"runningMin"`
	StreamingMin float64  `json:"streamingMin"`
	IdleMin      float64  `json:"idleMin"`
	EverStreamed bool     `json:"everStreamed"`
	AutoStopMin  *float64 `json:"autoStopMin"`
	CostPerHour  *float64 `json:"costPerHour"`
}

type Telemetry struct {
	Samples     []Sample `json:"samples"`
	Latest      *Sample  `json:"latest"`
	Alerts      []Alert  `json:"alerts"`
	Note        string   `json:"note"`
	Usage       *Usage   `json:"usage"`
	EgressPerGb *float64 `json:"egressPerGb"`
	DiskFullDay *float64 `json:"diskFullDays"`
}

// ---- connection / setup progress ------------------------------------------

type Stage struct {
	Percent float64 `json:"percent"`
	Key     string  `json:"key"`
	Message string  `json:"message"`
	Detail  string  `json:"detail"`
}

type Connection struct {
	Status      string `json:"status"`
	IP          string `json:"ipAddress"`
	SunshineURL string `json:"sunshineUrl"`
	Username    string `json:"username"`
	Password    string `json:"password"`
	Browser     struct {
		Desktop struct {
			URL       string `json:"url"`
			Available bool   `json:"available"`
		} `json:"desktop"`
		Play struct {
			URL       string `json:"url"`
			Available bool   `json:"available"`
		} `json:"play"`
	} `json:"browser"`
	Setup struct {
		Stages      []Stage `json:"stages"`
		Current     *Stage  `json:"current"`
		Ready       bool    `json:"ready"`
		Failed      bool    `json:"failed"`
		Stale       bool    `json:"stale"`
		Interrupted bool    `json:"interrupted"`
		Stuck       bool    `json:"stuck"`
		StopReason  string  `json:"stopReason"`
	} `json:"setup"`
}

// ---- operations (the Activity log) ----------------------------------------

type OpSummary struct {
	ID          string `json:"id"`
	MachineID   string `json:"machine_id"`
	Provider    string `json:"provider"`
	Action      string `json:"action"`
	Title       string `json:"title"`
	Status      string `json:"status"`
	Error       any    `json:"error"`
	CreatedAt   string `json:"created_at"`
	FinishedAt  string `json:"finished_at"`
	LastMessage string `json:"last_message"`
}

type OpEvent struct {
	ID      int    `json:"id"`
	Level   string `json:"level"`
	Message string `json:"message"`
	Detail  string `json:"detail"`
	At      string `json:"created_at"`
}

type Operation struct {
	OpSummary
	Events []OpEvent `json:"events"`
}

// ---- your own PCs ----------------------------------------------------------

type LocalMachine struct {
	ID         string         `json:"id"`
	Name       string         `json:"name"`
	LanIP      string         `json:"lanIp"`
	Online     bool           `json:"online"`
	LastSeenAt string         `json:"lastSeenAt"`
	Status     map[string]any `json:"status"`
}

// ---- the backend ------------------------------------------------------------

type Backend interface {
	Login(email, password string) (string, error)
	Me() (*User, error)
	Status() (*SystemStatus, error)
	Spend() (*Spend, error)
	Machines() ([]Machine, error)
	Options() (*Options, error)
	Telemetry(local bool, id string, minutes int) (*Telemetry, error)
	Connection(id string) (*Connection, error)
	// Act runs a machine action (start, stop, shelve, restore, sync, update-script,
	// resume-setup, pair, nickname, pricing, quality) and returns the answer's fields.
	Act(id, action string, body map[string]any) (map[string]any, error)
	Delete(id string) (map[string]any, error)
	Launch(req LaunchReq) (machineID, opID string, err error)
	Operations(limit int, machineID string) ([]OpSummary, error)
	Operation(id string, after int) (*Operation, error)
	LocalMachines() ([]LocalMachine, error)
}

// APIError is a failed call, with the backend's own words and advice.
type APIError struct {
	Status int
	Msg    string
	Tip    string
}

func (e *APIError) Error() string {
	if e.Tip != "" {
		return fmt.Sprintf("%s %s", strings.TrimRight(e.Msg, ". "), e.Tip)
	}
	return e.Msg
}

var ErrUnauthorized = errors.New("signed out: your token is no longer valid")

func opIDOf(res map[string]any) string {
	if s, ok := res["operationId"].(string); ok {
		return s
	}
	return ""
}
