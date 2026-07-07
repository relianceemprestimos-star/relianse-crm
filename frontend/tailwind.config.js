/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--color-bg) / <alpha-value>)',
        panel: 'rgb(var(--color-panel) / <alpha-value>)',
        panelAlt: 'rgb(var(--color-panel-alt) / <alpha-value>)',
        border: 'rgb(var(--color-border) / <alpha-value>)',
        accent: '#00D1C1',
        success: '#22C55E',
        info: '#3B82F6',
        danger: '#EF4444',
        muted: 'rgb(var(--color-muted) / <alpha-value>)',
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(0,209,193,.12), 0 20px 40px rgba(0,0,0,.35)',
      },
    },
  },
  plugins: [],
};
