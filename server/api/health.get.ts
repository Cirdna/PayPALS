// Smoke test: GET /api/health → { ok: true }. Safe to keep; never returns secrets.
export default defineEventHandler(() => ({
  ok: true,
  time: new Date().toISOString(),
  configured: {
    supabase: !!process.env.SUPABASE_URL,
    aiProvider: process.env.AI_PROVIDER || 'groq',
    ai: (process.env.AI_PROVIDER || 'groq') === 'google' ? !!process.env.GOOGLE_GENERATIVE_AI_API_KEY : !!process.env.GROQ_API_KEY,
    paypal: !!process.env.PAYPAL_CLIENT_ID,
    channel3: !!process.env.CHANNEL3_API_KEY,
    telegram: !!process.env.TELEGRAM_BOT_TOKEN,
  },
}))
