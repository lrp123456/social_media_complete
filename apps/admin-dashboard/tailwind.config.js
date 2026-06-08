import type { Config } from 'tailwindcss';

// ============================================================
// Obsidian & Cobalt Modular System — Design Tokens
// 来源: stitch_ai_media_matrix_admin/obsidian_cobalt_modular_system/DESIGN.md
// 适配 Tailwind 任意值,所有页面必须使用本文件定义的设计 token,
// 禁止临时自定义颜色/圆角/间距。
// ============================================================

const config: Config = {
  content: ['./src/**/*.{ts,tsx,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      // ---------- 颜色 ----------
      colors: {
        // Primary: Cobalt Blue
        primary: {
          DEFAULT:  '#004ac6',  // 主色(primary)
          container: '#2563eb', // 按钮/激活态(primary-container)
          dim:       '#b4c5ff', // inverse primary / fallback
          fixed:     '#dbe1ff', // 极浅主色(背景标签)
          tint:      '#0053db', // hover/active 调色
        },
        // Secondary: Obsidian Gray
        secondary: {
          DEFAULT:  '#575e70',
          container:'#d9dff5',
          fixed:    '#dce2f7',
        },
        // Tertiary: Muted Slate
        tertiary: {
          DEFAULT:  '#4e5562',
          container:'#666d7b',
          fixed:    '#dce2f3',
        },
        // Surface: Off-White 7 阶
        surface: {
          DEFAULT:           '#f8f9fa', // background
          dim:               '#d9dadb',
          bright:            '#f8f9fa',
          'container-lowest': '#ffffff',
          'container-low':    '#f3f4f5',
          'container':        '#edeeef',
          'container-high':   '#e7e8e9',
          'container-highest':'#e1e3e4',
          variant:           '#e1e3e4',
          tint:              '#0053db', // M3 surface-tint (= primary hover)
        },
        // On-Surface / Outline
        'on-surface':          '#191c1d',
        'on-surface-variant':  '#434655',
        outline:               '#737686',
        'outline-variant':     '#c3c6d7',
        // Inverse
        'inverse-surface':     '#2e3132',
        // Error
        error: {
          DEFAULT:   '#ba1a1a',
          container: '#ffdad6',
        },
        'on-primary':         '#ffffff',
        'on-primary-container': '#eeefff',
        'on-secondary':       '#ffffff',
        'on-secondary-container': '#5c6274',
        'on-tertiary':        '#ffffff',
        'on-tertiary-container': '#eaf0ff',
        'on-error':           '#ffffff',
        'on-error-container': '#93000a',
        'on-background':      '#191c1d',
        'inverse-on-surface': '#f0f1f2',
        // 状态点(对比高饱和文字 + 低饱和背景)
        status: {
          success: '#059669',
          warning: '#d97706',
          info:    '#2563eb',
          pending: '#6b7280',
        },
        // 平台品牌色(账号托管卡用)
        platform: {
          douyin:     '#000000',
          xiaohongshu:'#ff2442',
          tencent:    '#07c160',
          kuaishou:   '#fed91b',
          bilibili:   '#fb7299',
          baijiahao:  '#ff6f00',
          tiktok:     '#111111',
        },
      },
      // ---------- 圆角 ----------
      borderRadius: {
        none:  '0',
        sm:    '0.25rem',  // 4px
        DEFAULT:'0.5rem',  // 8px — buttons/inputs
        md:    '0.75rem',  // 12px — main containers
        lg:    '1rem',     // 16px
        xl:    '1.5rem',   // 24px
        '2xl': '2rem',
        full:  '9999px',   // pill / 圆形头像
      },
      // ---------- 间距(4px/8px scale) ----------
      spacing: {
        bento:        '1rem',     // 16px
        'bento-gap':  '1rem',
        section:      '3rem',     // 48px
        'section-margin': '3rem',
        container:    '2rem',     // 32px
        'container-padding': '2rem',
        inner:        '1.5rem',   // 24px
        'inner-component-padding': '1.5rem',
        'stack-sm':   '0.5rem',
        'stack-md':   '1rem',
      },
      // ---------- 字体 ----------
      fontFamily: {
        // Hanken Grotesk 主字体 + 系统 PingFang SC 中文兜底
        sans: ['"Hanken Grotesk"', '"PingFang SC"', 'Microsoft YaHei', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        display: ['"Hanken Grotesk"', '"PingFang SC"', 'serif'],
        body: ['"Hanken Grotesk"', '"PingFang SC"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'Menlo', 'Monaco', 'Courier New', 'monospace'],
      },
      // ---------- 字号 ----------
      fontSize: {
        display:           ['48px', { lineHeight: '1.1',    letterSpacing: '-0.02em', fontWeight: '700' }],
        'headline-lg':     ['32px', { lineHeight: '40px',   letterSpacing: '-0.01em', fontWeight: '600' }],
        'headline-lg-mobile': ['24px', { lineHeight: '32px', fontWeight: '600' }],
        'headline-md':     ['24px', { lineHeight: '32px',   fontWeight: '600' }],
        'body-lg':         ['18px', { lineHeight: '28px',   fontWeight: '400' }],
        'body-md':         ['16px', { lineHeight: '24px',   fontWeight: '400' }],
        'body-sm':         ['14px', { lineHeight: '20px',   fontWeight: '400' }],
        'label-md':        ['12px', { lineHeight: '16px',   letterSpacing: '0.05em', fontWeight: '600' }],
        'label-sm':        ['10px', { lineHeight: '14px',   letterSpacing: '0.05em', fontWeight: '600' }],
      },
      // ---------- 阴影(15% 透明,20px blur,0 offset) ----------
      boxShadow: {
        'bento':     '0 0 0 1px #e1e3e4',
        'floating':  '0 8px 20px 0 rgba(0, 0, 0, 0.08)',
        'modal':     '0 12px 32px 0 rgba(0, 0, 0, 0.12)',
        'inset-bento': 'inset 0 0 0 1px #c3c6d7',
      },
      // ---------- 动画 ----------
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '1' },
          '50%':      { opacity: '0.3' },
        },
        'spin-slow': {
          from: { transform: 'rotate(0deg)' },
          to:   { transform: 'rotate(360deg)' },
        },
        'shimmer': {
          '0%':   { backgroundPosition: '-1000px 0' },
          '100%': { backgroundPosition: '1000px 0' },
        },
      },
      animation: {
        'fade-in':   'fade-in 0.3s ease-out forwards',
        'pulse-dot': 'pulse-dot 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow': 'spin-slow 2s linear infinite',
        'shimmer':   'shimmer 2s linear infinite',
      },
      // ---------- 背景渐变(geometric/depth 氛围) ----------
      backgroundImage: {
        'grain': "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.4 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.4'/%3E%3C/svg%3E\")",
        'cobalt-glow': 'radial-gradient(circle at 50% 50%, rgba(37, 99, 235, 0.08) 0%, transparent 60%)',
      },
    },
  },
  plugins: [require('@tailwindcss/forms')],
};

export default config;
