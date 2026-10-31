package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
)

func num(p *float64) (float64, bool) {
	if p == nil {
		return 0, false
	}
	return *p, true
}

func alertLine(a Alert, width int) string {
	bar, st, label := "▌", sAccent, "NOTE"
	col := gCyan
	switch a.Level {
	case "critical":
		st, label, col = sBad, "CRITICAL", gRed
	case "warning":
		st, label, col = sWarn, "WARNING", gAmber
	}
	b := lipgloss.NewStyle().Foreground(col.color()).Render(bar)
	lines := wrap(a.Text, width-14)
	for i := range lines {
		if i == 0 {
			lines[i] = b + " " + lipgloss.NewStyle().Bold(true).Foreground(col.color()).Render(label) + "  " + st.Render(lines[i])
			// the label takes room: re-wrap the rest when the first line is too long
		} else {
			lines[i] = b + " " + st.Render(lines[i])
		}
	}
	return strings.Join(lines, "\n")
}

// renderMonitor: the same picture as the web Monitor tab, for a terminal.
// local = a PC at home (a smaller set of readings).
func renderMonitor(t *Telemetry, width int, local bool, rangeLabel string) string {
	if t == nil {
		return sDim.Render("Reading telemetry…")
	}
	var out []string
	s := t.Latest
	if s == nil {
		note := t.Note
		if note == "" {
			note = "No telemetry yet."
		}
		return sDim.Render(strings.Join(wrap(note, width), "\n"))
	}

	age := time.Since(time.Unix(s.T, 0))
	live := sGood.Render("● live")
	if age > 2*time.Minute {
		live = sWarn.Render("● no new reading")
	}
	head := live + sDim.Render(fmt.Sprintf("  reading from %s ago", shortDur(age)))
	if s.UP != nil {
		head += sDim.Render("  ·  up " + upFor(*s.UP))
	}
	head += sDim.Render("  ·  window " + rangeLabel)
	out = append(out, head)

	if t.Note != "" {
		out = append(out, sDim.Render(strings.Join(wrap(t.Note, width), "\n")))
	}
	for _, a := range t.Alerts {
		out = append(out, alertLine(a, width))
	}
	if ss := s.SS; ss != nil {
		var p []string
		if ss.R != "" {
			r := strings.Replace(ss.R, "x", "×", 1)
			if v, ok := num(ss.F); ok {
				r += fmt.Sprintf(" @ %.0f fps", v)
			}
			p = append(p, r)
		} else if v, ok := num(ss.F); ok {
			p = append(p, fmt.Sprintf("%.0f fps", v))
		}
		if ss.E != "" {
			p = append(p, ss.E)
		}
		if ss.D != "" {
			p = append(p, ss.D+"-bit")
		}
		if v, ok := num(ss.B); ok {
			p = append(p, fmt.Sprintf("target %.0f Mbit/s", v))
		}
		if len(p) > 0 {
			out = append(out, sDim.Render("Streaming now: ")+sText.Render(strings.Join(p, " · ")))
		}
	}

	sm := t.Samples
	cols := 4
	switch {
	case width < 70:
		cols = 1
	case width < 100:
		cols = 2
	case width < 140:
		cols = 3
	}

	var tiles []tile

	// GPU
	if u, ok := s.gnum("u"); ok {
		sub := ""
		if um, ok := s.gnum("um"); ok && !local {
			sub = fmt.Sprintf("peak %.0f%% %s", um, s.gstr("ps"))
		}
		if pw, ok := s.gnum("pw"); ok && local {
			sub = fmt.Sprintf("%.0f W", pw)
		}
		if eu, ok := s.gnum("eu"); ok {
			sub += fmt.Sprintf(" · encoder %.0f%%", eu)
		}
		tiles = append(tiles, tile{title: "GPU load", value: f0(u) + "%", sub: strings.TrimSpace(sub), max: 100, gaugeVal: u, gaugeMax: 100, trendLoad: true,
			trend: series(sm, func(x *Sample) (float64, bool) { return x.gnum("u") })})
	} else {
		tiles = append(tiles, tile{title: "GPU load", value: "no GPU data", sub: "driver not loaded yet?"})
	}
	if tp, ok := s.gnum("tp"); ok {
		tone := ""
		if tp >= 87 {
			tone = "bad"
		} else if tp >= 80 {
			tone = "warn"
		}
		sub := ""
		if pw, ok := s.gnum("pw"); ok {
			pl, _ := s.gnum("pl")
			sub = fmt.Sprintf("%.0f of %.0f W", pw, pl)
		}
		tiles = append(tiles, tile{title: "GPU temp", value: f0(tp) + " °C", sub: sub, tone: tone, max: 95, gaugeVal: tp, gaugeMax: 95, trendLoad: true,
			trend: series(sm, func(x *Sample) (float64, bool) { return x.gnum("tp") })})
	}
	if vu, ok := s.gnum("vu"); ok {
		vt, _ := s.gnum("vt")
		tone := ""
		if vt > 0 && vu/vt >= 0.95 {
			tone = "warn"
		}
		sub := ""
		if cl, ok := s.gnum("cl"); ok {
			cx, _ := s.gnum("cx")
			sub = fmt.Sprintf("%.0f of %.0f MHz", cl, cx)
		}
		tiles = append(tiles, tile{title: "Video memory", value: fmt.Sprintf("%.1f / %.0f GB", vu/1024, vt/1024), sub: sub, tone: tone, max: vt / 1024, gaugeVal: vu, gaugeMax: vt, trendLoad: true,
			trend: series(sm, func(x *Sample) (float64, bool) { v, ok := x.gnum("vu"); return v / 1024, ok })})
	}

	es, _ := s.gnum("es")
	if s.GF != nil {
		g := s.GF
		tone := ""
		if g.F != nil && *g.F < 30 {
			tone = "warn"
		}
		sub := fmt.Sprintf("low %s", fp(g.Lo, 0))
		if g.P1 != nil {
			sub += fmt.Sprintf(" · 1%% low %s", fp(g.P1, 0))
		}
		sub += fmt.Sprintf(" · worst frame %s ms", fp(g.Ft, 0))
		if g.Sc != nil && *g.Sc > 0 {
			sub += fmt.Sprintf(" · %.0f stutters/min", *g.Sc)
		}
		tiles = append(tiles, tile{title: "Game fps · " + g.N, value: fp(g.F, 0) + " fps", sub: sub, tone: tone, max: 240,
			trend: series(sm, func(x *Sample) (float64, bool) {
				if x.GF == nil || x.GF.F == nil {
					return 0, false
				}
				return *x.GF.F, true
			})})
	} else {
		val, sub := "not streaming", "starts when Moonlight connects"
		if es > 0 {
			val = "streaming"
			if ef, ok := s.gnum("ef"); ok {
				val = f0(ef) + " fps"
			}
			sub = fmt.Sprintf("%.0f session", es)
			if el, ok := s.gnum("el"); ok && !local {
				sub += fmt.Sprintf(" · %.1f ms encode", el/1000)
			}
		}
		tiles = append(tiles, tile{title: "Stream encoder", value: val, sub: sub,
			trend: series(sm, func(x *Sample) (float64, bool) {
				if e, _ := x.gnum("es"); e > 0 {
					ef, _ := x.gnum("ef")
					return ef, true
				}
				return 0, true
			})})
	}

	// CPU / RAM / network / disk
	if c, ok := num(s.C); ok {
		sub := ""
		if len(s.CC) == 2 {
			sub = fmt.Sprintf("busiest core %.0f%% of %.0f", s.CC[0], s.CC[1])
		}
		if !local {
			if sub != "" {
				sub += " · "
			}
			sub += fmt.Sprintf("peak %s%% · load %s", fp(s.CM, 0), fp(s.L, 1))
			if v, ok := num(s.CT); ok {
				sub += fmt.Sprintf(" · %.0f °C", v)
			}
		}
		tone := ""
		if cm, ok := num(s.CM); ok && cm >= 97 {
			tone = "warn"
		}
		tiles = append(tiles, tile{title: "CPU", value: f0(c) + "%", sub: sub, tone: tone, max: 100, gaugeVal: c, gaugeMax: 100, trendLoad: true,
			trend: series(sm, func(x *Sample) (float64, bool) { return num(x.C) })})
	}
	if len(s.M) == 2 && s.M[1] > 0 {
		tone := ""
		if s.M[0]/s.M[1] >= 0.92 {
			tone = "warn"
		}
		sub := fmt.Sprintf("%.0f%% used", s.M[0]/s.M[1]*100)
		if v, ok := num(s.Sw); ok && v > 0 {
			sub = fmt.Sprintf("swap %.1f GB", v)
		}
		tiles = append(tiles, tile{title: "RAM", value: fmt.Sprintf("%.1f / %.1f GB", s.M[0], s.M[1]), sub: sub, tone: tone, max: s.M[1], gaugeVal: s.M[0], gaugeMax: s.M[1], trendLoad: true,
			trend: series(sm, func(x *Sample) (float64, bool) {
				if len(x.M) == 2 {
					return x.M[0], true
				}
				return 0, false
			})})
	}
	if no, ok := num(s.NO); ok {
		tiles = append(tiles, tile{title: "Network out", value: f1(no) + " Mbit/s", sub: "in " + fp(s.NI, 1) + " Mbit/s",
			trend: series(sm, func(x *Sample) (float64, bool) { return num(x.NO) })})
	}
	if len(s.D) == 2 && s.D[1] > 0 {
		tone := ""
		if s.D[0]/s.D[1] >= 0.9 {
			tone = "warn"
		}
		var sub string
		if local {
			sub = fmt.Sprintf("%.0f%% used", s.D[0]/s.D[1]*100)
		} else {
			sub = fmt.Sprintf("read %s · write %s MB/s", fp(s.DR, 1), fp(s.DW, 1))
		}
		if len(s.DL) >= 2 && s.DL[0] != nil {
			sub += fmt.Sprintf(" · %s/%s ms", fp(s.DL[0], 1), fp(s.DL[1], 1))
		}
		if t.DiskFullDay != nil {
			sub += fmt.Sprintf(" · full in ~%.0f d", *t.DiskFullDay)
		}
		tiles = append(tiles, tile{title: "Disk", value: fmt.Sprintf("%.0f / %.0f GB", s.D[0], s.D[1]), sub: sub, tone: tone, gaugeVal: s.D[0], gaugeMax: s.D[1],
			trend: series(sm, func(x *Sample) (float64, bool) {
				if local {
					if len(x.D) == 2 {
						return x.D[0], true
					}
					return 0, false
				}
				if x.DR == nil && x.DW == nil {
					return 0, false
				}
				a, b := 0.0, 0.0
				if x.DR != nil {
					a = *x.DR
				}
				if x.DW != nil {
					b = *x.DW
				}
				return a + b, true
			})})
	}

	// Detail tiles
	if s.RT != nil || es > 0 {
		val, sub, tone := "measuring…", "measured while you stream", ""
		if s.RT != nil {
			if s.RT.O == 1 {
				val, sub = "no ping reply", "your device ignores ping"
			} else if s.RT.R != nil {
				val = f0(*s.RT.R) + " ms"
				sub = fmt.Sprintf("jitter %s ms · loss %s%%", fp(s.RT.J, 1), fp(s.RT.L, 0))
				if (s.RT.L != nil && *s.RT.L >= 2) || *s.RT.R >= 80 {
					tone = "warn"
				}
			}
		}
		tiles = append(tiles, tile{title: "Connection to you", value: val, sub: sub, tone: tone,
			trend: series(sm, func(x *Sample) (float64, bool) {
				if x.RT == nil || x.RT.R == nil {
					return 0, false
				}
				return *x.RT.R, true
			})})
	}
	if len(s.NE) >= 2 {
		bad := s.NE[0] + s.NE[1]
		val := "none"
		if bad > 0 {
			val = fmt.Sprintf("%.0f problems", bad)
		}
		tone := ""
		if bad >= 10 || (len(s.NE) > 2 && s.NE[2] >= 5) {
			tone = "warn"
		}
		sub := fmt.Sprintf("errors %.0f · drops %.0f", s.NE[0], s.NE[1])
		if len(s.NE) > 2 && s.NE[2] > 0 {
			sub += fmt.Sprintf(" · UDP %.0f", s.NE[2])
		}
		tiles = append(tiles, tile{title: "Network errors", value: val, sub: sub, tone: tone,
			trend: series(sm, func(x *Sample) (float64, bool) {
				if len(x.NE) < 2 {
					return 0, false
				}
				v := x.NE[0] + x.NE[1]
				if len(x.NE) > 2 {
					v += x.NE[2]
				}
				return v, true
			})})
	}
	if tx, ok := num(s.TX); ok {
		sub := "since boot"
		if t.EgressPerGb != nil && !local {
			sub = fmt.Sprintf("since boot · ≈ %s at %s/GB", money(tx**t.EgressPerGb), money(*t.EgressPerGb))
		}
		tiles = append(tiles, tile{title: "Data sent", value: fmt.Sprintf("%.2f GB", tx), sub: sub,
			trend: series(sm, func(x *Sample) (float64, bool) { return num(x.TX) })})
	}
	if u := t.Usage; u != nil && !local {
		pct := 0.0
		if u.RunningMin > 0 {
			pct = u.StreamingMin / u.RunningMin * 100
		}
		sub := fmt.Sprintf("of %s up (%.0f%%)", mins(u.RunningMin), pct)
		if u.CostPerHour != nil {
			sub += fmt.Sprintf(" · idle ≈ %s", money((u.RunningMin-u.StreamingMin)/60**u.CostPerHour))
		}
		tone := ""
		switch {
		case u.AutoStopMin == nil || *u.AutoStopMin == 0:
			sub += " · auto-stop off"
		case es > 0:
		case !u.EverStreamed:
			sub += " · auto-stop waits for your first stream"
		default:
			left := *u.AutoStopMin - u.IdleMin
			if left > 0 {
				sub += fmt.Sprintf(" · auto-stop in ~%.0f min", left)
				if left <= 5 {
					tone = "warn"
				}
			} else {
				sub += " · auto-stop due"
			}
		}
		tiles = append(tiles, tile{title: "This session", value: mins(u.StreamingMin) + " streaming", sub: sub, tone: tone})
	}
	if len(s.PR) > 0 {
		worst, any := 0.0, false
		for _, v := range s.PR {
			if v != nil {
				any = true
				if *v > worst {
					worst = *v
				}
			}
		}
		if any {
			sub := fmt.Sprintf("cpu %s · memory %s · disk %s%%", fp(at(s.PR, 0), 0), fp(at(s.PR, 1), 0), fp(at(s.PR, 2), 0))
			if cs, ok := num(s.CS); ok && cs >= 1 {
				sub += fmt.Sprintf(" · steal %.0f%%", cs)
			}
			tone := ""
			if worst >= 25 {
				tone = "warn"
			}
			tiles = append(tiles, tile{title: "Waiting (stalls)", value: f0(worst) + "%", sub: sub, tone: tone, max: 100, gaugeVal: worst, gaugeMax: 100, trendLoad: true,
				trend: series(sm, func(x *Sample) (float64, bool) {
					m, any := 0.0, false
					for _, v := range x.PR {
						if v != nil {
							any = true
							if *v > m {
								m = *v
							}
						}
					}
					return m, any
				})})
		}
	}
	if lw, ok := s.gnum("lw"); ok {
		lm, _ := s.gnum("lm")
		lg, _ := s.gnum("lg")
		lx, _ := s.gnum("lx")
		u, _ := s.gnum("u")
		reduced := lw < lm || lg < lx
		tone, sub := "", fmt.Sprintf("max x%.0f · gen %.0f", lm, lx)
		if reduced && u >= 30 {
			tone = "warn"
		} else if reduced {
			sub += " (idle: saves power)"
		}
		if fs, ok := s.gnum("fs"); ok {
			sub += fmt.Sprintf(" · fan %.0f%%", fs)
		}
		tiles = append(tiles, tile{title: "GPU link", value: fmt.Sprintf("x%.0f · gen %.0f", lw, lg), sub: sub, tone: tone})
	}

	out = append(out, grid(tiles, width, cols))

	// Lists: programs, GPU programs, containers, errors
	var left, mid, right []string
	left = append(left, sectionTitle("BUSIEST PROGRAMS"))
	for _, p := range s.P {
		if len(p) == 2 {
			left = append(left, pad(p[0], 24)+sDim.Render(p[1]+"%"))
		}
	}
	if len(s.GP) > 0 {
		left = append(left, "", sectionTitle("ON THE GPU"))
		for _, p := range s.GP {
			name, _ := p[0].(string)
			mib, _ := p[1].(float64)
			line := pad(name, 24) + sDim.Render(fmt.Sprintf("%.1f GB", mib/1024))
			if len(p) > 2 {
				if pc, ok := p[2].(float64); ok {
					line += sDim.Render(fmt.Sprintf(" · %.0f%%", pc))
				}
			}
			left = append(left, line)
		}
	}
	mid = append(mid, sectionTitle("CONTAINERS"))
	for _, k := range s.K {
		if strings.Contains(k, ": Up") {
			mid = append(mid, sGood.Render("✓ ")+truncate(k, 34))
		} else {
			mid = append(mid, sWarn.Render("▲ ")+truncate(k, 34))
		}
	}
	if len(s.K) == 0 {
		mid = append(mid, sDim.Render("none yet"))
	}
	if len(s.F) > 0 {
		mid = append(mid, sWarn.Render("▲ failed: "+strings.Join(s.F, ", ")))
	}
	if s.SN != nil && s.SN.X > 1 {
		mid = append(mid, sWarn.Render(fmt.Sprintf("▲ Sunshine restarted %d times", s.SN.X)))
	}
	right = append(right, sectionTitle("ERRORS SINCE BOOT"))
	if s.X > 0 {
		right = append(right, sBad.Render(fmt.Sprintf("✖ %d GPU (Xid)", s.X)))
	} else {
		right = append(right, sGood.Render("✓ no GPU errors"))
	}
	if s.O > 0 {
		right = append(right, sBad.Render(fmt.Sprintf("✖ %d out-of-memory kills", s.O)))
	} else {
		right = append(right, sGood.Render("✓ no out-of-memory kills"))
	}
	if width >= 100 {
		w := width / 3
		cell := func(lines []string) string { return sBox.Width(w - 2).Render(strings.Join(lines, "\n")) }
		out = append(out, lipglossJoin(cell(left), cell(mid), cell(right)))
	} else {
		out = append(out, strings.Join(left, "\n"), strings.Join(mid, "\n"), strings.Join(right, "\n"))
	}
	return strings.Join(out, "\n")
}

func at(v []*float64, i int) *float64 {
	if i < len(v) {
		return v[i]
	}
	return nil
}

func shortDur(d time.Duration) string {
	if d < 90*time.Second {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	return fmt.Sprintf("%d min", int(d.Minutes()))
}
