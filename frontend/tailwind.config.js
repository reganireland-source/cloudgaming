const defaultTheme = require('tailwindcss/defaultTheme');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx}',
    './pages/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    // Breakpoints: xs (at least 400px wide) is listed BEFORE the defaults so
    // its CSS comes first and larger ones (sm, md, lg, xl) still override it.
    // short = screens under 600px TALL (square phones like the Unihertz
    // Titan 2 Elite, or any phone in landscape) — used to stop the header and
    // status bar pinning to the top and eating space.
    screens: {
      xs: '400px',
      ...defaultTheme.screens,
      short: { raw: '(max-height: 600px)' },
    },
    extend: {
      // Phosphor-terminal palette: the same hues as the original neon set,
      // pulled back in saturation so they read as CRT phosphor rather than
      // blacklight. Names unchanged so every existing class picks these up.
      colors: {
        'neon-cyan': '#5fd7e0',
        'neon-magenta': '#d487e8',
        'neon-lime': '#8fd694',
        'neon-purple': '#a48cf0',
        'neon-pink': '#ec8aa8',
        'neon-amber': '#e8b863',
        'cyber-dark': '#0c1018',
        'cyber-darker': '#080b11',
        'cyber-panel': '#111723',
        'cyber-line': '#1f2937',
      },
      fontFamily: {
        'mono': ['"IBM Plex Mono"', 'ui-monospace', 'Menlo', 'monospace'],
        'sans': ['"IBM Plex Sans"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        'tech': ['"IBM Plex Mono"', 'ui-monospace', 'Menlo', 'monospace'],
      },
      boxShadow: {
        'neon-cyan': '0 0 0 1px rgba(95, 215, 224, 0.25), 0 4px 18px -6px rgba(95, 215, 224, 0.25)',
        'neon-magenta': '0 0 0 1px rgba(212, 135, 232, 0.25), 0 4px 18px -6px rgba(212, 135, 232, 0.25)',
        'neon-lime': '0 0 0 1px rgba(143, 214, 148, 0.25), 0 4px 18px -6px rgba(143, 214, 148, 0.25)',
        'neon-pink': '0 0 0 1px rgba(236, 138, 168, 0.25), 0 4px 18px -6px rgba(236, 138, 168, 0.25)',
      },
      backgroundImage: {
        'grid-pattern':
          'linear-gradient(rgba(95, 215, 224, 0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(95, 215, 224, 0.035) 1px, transparent 1px)',
      },
      backgroundSize: {
        'grid': '32px 32px',
      },
      letterSpacing: {
        'label': '0.08em',
      },
      // Any `border`/`divide` with no explicit colour otherwise falls back to
      // Tailwind's light-mode gray-200, which reads as a bright white rule here.
      borderColor: {
        DEFAULT: 'rgba(255, 255, 255, 0.07)',
      },
    },
  },
  plugins: [],
}
