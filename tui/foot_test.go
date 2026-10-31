package main

import (
	"strings"
	"testing"
)

func TestFooterShowsAllShortcuts(t *testing.T) {
	for _, w := range []int{80, 140} {
		h := newHarness(t, w, 40)
		h.m.authed = true
		h.exec(h.m.afterLogin())
		h.poll()
		check := func(label string, wants ...string) {
			v := stripANSI(h.view())
			lines := strings.Split(v, "\n")
			foot := strings.Join(lines[len(lines)-5:], "\n")
			for _, want := range wants {
				if !strings.Contains(foot, want) {
					t.Errorf("w=%d %s: footer lacks %q\n%s", w, label, want, foot)
				}
			}
			if len(lines) != 40 {
				t.Errorf("w=%d %s: %d lines", w, label, len(lines))
			}
			for i, l := range lines {
				if lenCells(l) > w {
					t.Errorf("w=%d %s: line %d is %d cells", w, label, i, lenCells(l))
				}
			}
		}
		check("running", "stop", "shelve", "pair Moonlight", "rename", "update script", "update+restart", "resume setup", "spot/on-demand", "sync", "delete", "window", "copy password", "show password", "copy IP", "open Sunshine", "screens", "new machine", "refresh", "help", "sign out", "quit")
		h.key("down")
		check("stopped", "start", "shelve", "delete")
		h.key("down")
		check("shelved", "restore", "delete")
		h.key("2")
		check("activity", "open log", "choose")
		h.key("3")
		check("local", "PC", "window")
		h.key("n")
		check("wizard purpose", "choose", "next", "cancel")
		if os := h.view(); w == 80 {
			show(t, "footer 80", os)
		}
	}
}
