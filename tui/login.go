package main

import (
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
)

// ---- sign in ---------------------------------------------------------------

type loginModel struct {
	email, pass, token textinput.Model
	mode               int // 0 email + password, 1 paste a token
	focus              int
	busy               bool
	err                string
}

func newLogin() loginModel {
	e := textinput.New()
	e.Placeholder = "you@example.com"
	e.Width = 44
	e.Focus()
	p := textinput.New()
	p.Placeholder = "password"
	p.Width = 44
	p.EchoMode = textinput.EchoPassword
	t := textinput.New()
	t.Placeholder = "paste the cg_token value"
	t.Width = 44
	t.EchoMode = textinput.EchoPassword
	return loginModel{email: e, pass: p, token: t}
}

func (m *model) loginKey(k tea.KeyMsg) (tea.Model, tea.Cmd) {
	l := &m.login
	if l.busy {
		return m, nil
	}
	switch k.String() {
	case "esc", "ctrl+q":
		m.quitting = true
		return m, tea.Quit
	case "ctrl+r":
		if m.cfg.Token != "" {
			m.err = ""
			return m, m.checkMe()
		}
		return m, nil
	case "ctrl+t", "f2":
		l.mode = 1 - l.mode
		l.focus, l.err = 0, ""
		l.focusOnly()
		return m, nil
	case "tab", "down":
		if l.mode == 0 {
			l.focus = (l.focus + 1) % 2
			l.focusOnly()
		}
		return m, nil
	case "shift+tab", "up":
		if l.mode == 0 {
			l.focus = (l.focus + 1) % 2
			l.focusOnly()
		}
		return m, nil
	case "enter":
		if l.mode == 0 {
			if l.focus == 0 && strings.TrimSpace(l.email.Value()) != "" {
				l.focus = 1
				l.focusOnly()
				return m, nil
			}
			if l.email.Value() == "" || l.pass.Value() == "" {
				l.err = "Enter your email and password."
				return m, nil
			}
			l.busy, l.err = true, ""
			be, email, pass := m.be, strings.TrimSpace(l.email.Value()), l.pass.Value()
			return m, func() tea.Msg {
				tok, err := be.Login(email, pass)
				return loginMsg{tok, err}
			}
		}
		tok := strings.TrimSpace(l.token.Value())
		if tok == "" {
			l.err = "Paste your token first."
			return m, nil
		}
		l.busy, l.err = true, ""
		return m, func() tea.Msg { return loginMsg{token: tok} }
	}
	var c tea.Cmd
	if l.mode == 1 {
		l.token, c = l.token.Update(k)
	} else if l.focus == 0 {
		l.email, c = l.email.Update(k)
	} else {
		l.pass, c = l.pass.Update(k)
	}
	return m, c
}

func (l *loginModel) focusOnly() {
	l.email.Blur()
	l.pass.Blur()
	l.token.Blur()
	switch {
	case l.mode == 1:
		l.token.Focus()
	case l.focus == 0:
		l.email.Focus()
	default:
		l.pass.Focus()
	}
}

func (m *model) loginView() string {
	l := m.login
	var b strings.Builder
	b.WriteString(gradientText("GGGH", gCyan, gViol, true) + sDim.Render("  Gints Global Gaming Hubjob · terminal edition") + "\n")
	b.WriteString(gradientText(strings.Repeat("▀", 52), gCyan, gViol, false) + "\n\n")
	if l.mode == 0 {
		b.WriteString(sDim.Render("Email") + "\n" + l.email.View() + "\n\n")
		b.WriteString(sDim.Render("Password") + "\n" + l.pass.View() + "\n\n")
		b.WriteString(sDim.Render("Signed up with Google or Apple? Press ctrl+t and paste your token instead.") + "\n")
	} else {
		b.WriteString(sDim.Render("Token") + "\n" + l.token.View() + "\n\n")
		b.WriteString(sDim.Render("In the web app, open your browser's developer tools → Application → Local Storage,\ncopy the value of cg_token, and paste it here. It is stored only in "+configPath()+".") + "\n")
	}
	b.WriteString("\n")
	switch {
	case l.busy:
		b.WriteString(m.spin.View() + " signing in…")
	case l.err != "":
		b.WriteString(sBad.Render("✖ " + l.err))
	case m.err != "":
		b.WriteString(sBad.Render("✖ " + m.err))
	}
	b.WriteString("\n\n" + sDim.Render("enter next/sign in · tab switch field · ctrl+t email ⇄ token · esc quit"+func() string {
		if m.cfg.Token != "" {
			return " · ctrl+r retry saved sign-in"
		}
		return ""
	}()))
	if m.demo {
		b.WriteString("\n" + sWarn.Render("demo mode: any input works"))
	}
	box := sBox.Padding(1, 3).Render(b.String())
	return placeCenter(box, m.w, m.h)
}

// ---- an operation's log -------------------------------------------------------

type opView struct {
	id       string
	title    string
	status   string
	errText  string
	events   []OpEvent
	after    int
	done     bool
	inflight bool
	fetched  time.Time
	vp       viewport.Model
}

func newOpView(id string) *opView {
	return &opView{id: id, vp: viewport.New(80, 20)}
}

func (o *opView) add(op *Operation) {
	o.title, o.status = op.Title, op.Status
	if s, ok := op.Error.(string); ok {
		o.errText = s
	} else if mm, ok := op.Error.(map[string]any); ok {
		if t, ok := mm["title"].(string); ok {
			o.errText = t
		}
	}
	for _, e := range op.Events {
		if e.ID > o.after {
			o.after = e.ID
		}
		o.events = append(o.events, e)
	}
	o.done = op.Status == "succeeded" || op.Status == "failed"
}
