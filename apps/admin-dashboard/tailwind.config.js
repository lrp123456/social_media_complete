import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary:    { DEFAULT: '#004ac6', container: '#2563eb', dim: '#b4c5ff' },
        secondary:  { DEFAULT: '#575e70', container: '#d9dff5' },
        tertiary:   { DEFAULT: '#4e5562', container: '#666d7b' },
        surface:    { DEFAULT: '#f8f9fa', dim: '#d9dadb', high: '#e7e8e9', highest: '#e1e3e4' },
        'on-surface': '#191c1d',
        'on-surface-variant': '#434655',
        error:      { DEFAULT: '#ba1a1a', container: '#ffdad6' },
      },
      borderRadius: {
        sm: '0.25rem', DEFAULT: '0.5rem', md: '0.75rem', lg: '1rem', xl: '1.5rem',
      },
      spacing: { bento: '1rem', section: '3rem', container: '2rem', inner: '1.5rem' },
    },
  },
  plugins: [require('@tailwindcss/forms')],
};
export default config;
