import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./renderer/index.html', './renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#F19894',
          50: '#FDF3F2',
          100: '#FBE5E3',
          200: '#F8D2CE',
          300: '#F8B8B4',
          400: '#F4A5A1',
          500: '#F19894',
          600: '#E27874',
          700: '#C55B57',
          800: '#9A4744',
          light: '#FCEDEB',
          ink: '#7A4D49',
        },
        ink: {
          DEFAULT: '#2A1F1F',
          soft: '#574747',
        },
        bg: {
          DEFAULT: '#FFFAF9',
          top: '#FFF4F1',
          bottom: '#FFFBF9',
        },
        card: '#FFFFFF',
        muted: {
          DEFAULT: '#8E8484',
          faint: '#B5ACAA',
        },
        hairline: '#F0DFDD',
      },
      fontFamily: {
        sans: [
          '"Hiragino Sans"',
          '"YuGothic"',
          '"Yu Gothic"',
          '"Noto Sans JP"',
          'system-ui',
          'sans-serif',
        ],
        serif: [
          '"Noto Serif JP"',
          '"Hiragino Mincho ProN"',
          '"Yu Mincho"',
          'serif',
        ],
      },
      borderRadius: {
        card: '16px',
        chip: '20px',
        input: '14px',
        hero: '32px',
      },
      boxShadow: {
        card: '0 2px 8px rgb(0 0 0 / 6%)',
        soft: '0 1px 3px rgb(0 0 0 / 4%)',
        brand: '0 14px 32px -10px rgba(226, 120, 116, 0.35)',
        'brand-sm': '0 8px 20px -8px rgba(226, 120, 116, 0.28)',
      },
      backgroundImage: {
        'brand-gradient': 'linear-gradient(135deg, #F19894 0%, #E27874 100%)',
        'brand-soft': 'linear-gradient(135deg, #FDF3F2 0%, #FBE5E3 60%, #F8D2CE 100%)',
        'page-gradient': 'linear-gradient(180deg, #FFF4F1 0%, #FFFBF9 50%, #FFF9F7 100%)',
        'desk-aurora':
          'radial-gradient(at 12% 8%, rgba(248,184,180,0.55) 0px, transparent 50%), radial-gradient(at 88% 14%, rgba(244,165,161,0.45) 0px, transparent 45%), radial-gradient(at 70% 92%, rgba(251,229,227,0.75) 0px, transparent 55%)',
      },
    },
  },
  plugins: [],
};

export default config;
