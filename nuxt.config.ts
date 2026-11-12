// Owner: C. Ask before changing — everyone builds on this.
export default defineNuxtConfig({
  compatibilityDate: '2026-11-01',
  devtools: { enabled: false },
  modules: ['@nuxt/ui', '@nuxtjs/supabase'],
  css: ['~/assets/css/main.css'],

  // System fonts only: no font downloads at build time (faster, deterministic builds).
  ui: { fonts: false },

  // @nuxtjs/supabase reads SUPABASE_URL + SUPABASE_KEY (browser-safe) from env at build time.
  supabase: {
    types: false,
    redirect: true,
    redirectOptions: {
      login: '/login',
      callback: '/confirm',
      // Pages that do NOT need a login. (This only guards pages; /api/** routes are never redirected.)
      exclude: ['/'],
      saveRedirectToCookie: false,
    },
  },

  runtimeConfig: {
    // Server-only secrets are read from process.env in server/lib/env.ts (works in Nitro, vitest and tsx scripts).
    public: {
      appUrl: process.env.APP_URL || 'http://localhost:3000',
      demoMode: process.env.DEMO_MODE !== 'false',
      /** Pause between negotiation rounds in the browser. Override at runtime with NUXT_PUBLIC_NEGOTIATION_STEP_PAUSE_MS. */
      negotiationStepPauseMs: 6000,
      telegramBotUsername: process.env.TELEGRAM_BOT_USERNAME || '',
      demoEmail: process.env.DEMO_EMAIL || '',
      demoPassword: process.env.DEMO_PASSWORD || '',
    },
  },

  nitro: {
    // Vercel: allow scan / negotiation requests up to 60 s.
    vercel: { functions: { maxDuration: 60 } },
  },

  typescript: { strict: true },
})
