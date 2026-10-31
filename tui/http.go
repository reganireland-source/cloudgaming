package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// HTTPBackend talks to the real GGGH API (the Railway backend).
type HTTPBackend struct {
	base  string
	token string
	c     *http.Client
}

func NewHTTP(base, token string) *HTTPBackend {
	return &HTTPBackend{base: strings.TrimRight(base, "/"), token: token, c: &http.Client{Timeout: 45 * time.Second}}
}

func (h *HTTPBackend) SetToken(t string) { h.token = t }

func (h *HTTPBackend) call(method, path string, in, out any) error {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return err
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, h.base+path, body)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if h.token != "" {
		req.Header.Set("Authorization", "Bearer "+h.token)
	}
	resp, err := h.c.Do(req)
	if err != nil {
		return fmt.Errorf("can't reach GGGH (%v)", shortErr(err))
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode == http.StatusUnauthorized && h.token != "" && !strings.HasPrefix(path, "/auth/login") {
		return ErrUnauthorized
	}
	if resp.StatusCode >= 400 {
		var e struct {
			Error    string         `json:"error"`
			Tip      string         `json:"tip"`
			Friendly map[string]any `json:"friendly"`
		}
		_ = json.Unmarshal(data, &e)
		msg := e.Error
		if t, ok := e.Friendly["title"].(string); ok && t != "" {
			msg = t
		}
		if msg == "" {
			msg = "request failed (HTTP " + strconv.Itoa(resp.StatusCode) + ")"
		}
		return &APIError{Status: resp.StatusCode, Msg: msg, Tip: e.Tip}
	}
	if out == nil || len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("unexpected answer from GGGH: %v", err)
	}
	return nil
}

func shortErr(err error) string {
	if ue, ok := err.(*url.Error); ok {
		return ue.Err.Error()
	}
	return err.Error()
}

func (h *HTTPBackend) Login(email, password string) (string, error) {
	var out struct {
		Token string `json:"token"`
	}
	err := h.call("POST", "/auth/login", map[string]string{"email": email, "password": password}, &out)
	if err == nil {
		h.token = out.Token
	}
	return out.Token, err
}

func (h *HTTPBackend) Me() (*User, error) {
	var out struct {
		User User `json:"user"`
	}
	err := h.call("GET", "/auth/me", nil, &out)
	return &out.User, err
}

func (h *HTTPBackend) Status() (*SystemStatus, error) {
	var out SystemStatus
	err := h.call("GET", "/status", nil, &out)
	return &out, err
}

func (h *HTTPBackend) Spend() (*Spend, error) {
	var out Spend
	err := h.call("GET", "/costs/summary", nil, &out)
	return &out, err
}

func (h *HTTPBackend) Machines() ([]Machine, error) {
	var out []Machine
	err := h.call("GET", "/machines", nil, &out)
	return out, err
}

func (h *HTTPBackend) Options() (*Options, error) {
	var out Options
	err := h.call("GET", "/machines/options", nil, &out)
	return &out, err
}

func (h *HTTPBackend) Telemetry(local bool, id string, minutes int) (*Telemetry, error) {
	base := "/machines/"
	if local {
		base = "/local-machines/"
	}
	var out Telemetry
	err := h.call("GET", fmt.Sprintf("%s%s/telemetry?minutes=%d", base, id, minutes), nil, &out)
	return &out, err
}

func (h *HTTPBackend) Connection(id string) (*Connection, error) {
	var out Connection
	err := h.call("GET", "/machines/"+id+"/connection", nil, &out)
	return &out, err
}

func (h *HTTPBackend) Act(id, action string, body map[string]any) (map[string]any, error) {
	if body == nil {
		body = map[string]any{}
	}
	var out map[string]any
	err := h.call("POST", "/machines/"+id+"/"+action, body, &out)
	return out, err
}

func (h *HTTPBackend) Delete(id string) (map[string]any, error) {
	var out map[string]any
	err := h.call("DELETE", "/machines/"+id, nil, &out)
	return out, err
}

func (h *HTTPBackend) Launch(req LaunchReq) (string, string, error) {
	var out struct {
		MachineID   string `json:"machineId"`
		OperationID string `json:"operationId"`
	}
	err := h.call("POST", "/machines", req, &out)
	return out.MachineID, out.OperationID, err
}

func (h *HTTPBackend) Operations(limit int, machineID string) ([]OpSummary, error) {
	q := fmt.Sprintf("/operations?limit=%d", limit)
	if machineID != "" {
		q += "&machineId=" + url.QueryEscape(machineID)
	}
	var out []OpSummary
	err := h.call("GET", q, nil, &out)
	return out, err
}

func (h *HTTPBackend) Operation(id string, after int) (*Operation, error) {
	var out Operation
	err := h.call("GET", fmt.Sprintf("/operations/%s?after=%d", id, after), nil, &out)
	return &out, err
}

func (h *HTTPBackend) LocalMachines() ([]LocalMachine, error) {
	var out []LocalMachine
	err := h.call("GET", "/local-machines", nil, &out)
	return out, err
}
