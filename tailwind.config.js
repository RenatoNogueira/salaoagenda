/** @type {import('tailwindcss').Config} */
const v = (name) => `rgb(var(--${name}) / <alpha-value>)`;

module.exports = {
  darkMode: 'class',
  content: ['./views/**/*.ejs', './public/js/**/*.js'],
  theme: {
    extend: {
      colors: {
        // As cores vêm de variáveis CSS (definidas em src/input.css e em runtime pela cor do painel),
        // assim o mesmo markup serve para o tema claro e para o escuro.
        brand: { DEFAULT: v('brand'), dark: v('brand-dark'), soft: v('brand-soft'), 2: v('brand-2') },
        accent: v('accent'),
        surface: v('surface'),
        slate: {
          50: v('slate-50'),
          100: v('slate-100'),
          200: v('slate-200'),
          300: v('slate-300'),
          400: v('slate-400'),
          500: v('slate-500'),
          600: v('slate-600'),
          700: v('slate-700'),
          800: v('slate-800'),
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
