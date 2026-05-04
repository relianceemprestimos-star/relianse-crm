/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#050B12',
        panel: '#0D1822',
        panelAlt: '#101B26',
        border: '#1F2D3A',
        accent: '#00D1C1',
        success: '#22C55E',
        info: '#3B82F6',
        danger: '#EF4444',
        muted: '#94A3B8',
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(0,209,193,.12), 0 20px 40px rgba(0,0,0,.35)',
      },
    },
  },
  plugins: [],
};
