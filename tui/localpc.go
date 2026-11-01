package main

import (
	"os"
	"os/exec"
	"runtime"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
)

// NewLocalPC is a freshly added local PC: its install command carries the agent's private token.
type NewLocalPC struct {
	Machine        LocalMachine `json:"machine"`
	InstallCommand string       `json:"installCommandUnix"`
}

type addLocalMsg struct {
	pc  *NewLocalPC
	err error
}
type installDoneMsg struct {
	name string
	err  error
}

// startMakeLocal: "P" asks for a name, then adds this computer as a local PC and installs the agent on it.
func (m *model) startMakeLocal() tea.Cmd {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		m.setNotice("Making this a local PC works from macOS and Linux. On Windows use the web app.", true)
		return nil
	}
	host, _ := os.Hostname()
	host = strings.TrimSuffix(host, ".local")
	if host == "" {
		host = "My PC"
	}
	ti := textinput.New()
	ti.SetValue(host)
	ti.CharLimit = 40
	ti.Focus()
	m.prompt = &prompt{kind: pInput, title: "Make this a local GGGH PC: name it (then installs the agent; asks for your password)", ti: ti,
		run: func(m *model, v string) tea.Cmd {
			if v == "" {
				return nil
			}
			m.setNotice("Adding "+v+"…", false)
			be := m.be
			return func() tea.Msg {
				pc, err := be.AddLocalMachine(v)
				return addLocalMsg{pc, err}
			}
		}}
	return nil
}

// onAddLocal runs the installer in this terminal (sudo needs it), then goes back to the TUI.
func (m *model) onAddLocal(msg addLocalMsg) tea.Cmd {
	if msg.err != nil {
		m.setNotice("Could not add the PC: "+msg.err.Error(), true)
		return nil
	}
	name := msg.pc.Machine.Name
	delete(m.last, "local")
	if m.demo || msg.pc.InstallCommand == "" {
		m.setNotice("Demo: "+name+" would be installed here.", false)
		return nil
	}
	c := exec.Command("bash", "-c", msg.pc.InstallCommand)
	return tea.ExecProcess(c, func(err error) tea.Msg { return installDoneMsg{name, err} })
}

func (m *model) onInstallDone(msg installDoneMsg) tea.Cmd {
	delete(m.last, "local")
	if msg.err != nil {
		m.setNotice("The install did not finish ("+msg.err.Error()+"). "+msg.name+" is added: run its install command from the web app to retry.", true)
		return nil
	}
	m.setNotice(msg.name+" is installed. It shows up as online in a few seconds.", false)
	return m.cmdLocal()
}
