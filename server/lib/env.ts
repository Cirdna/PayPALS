/**
 * Server-side environment access. Framework-free on purpose: works in Nitro routes, vitest and tsx scripts.
 * NEVER import this file from app/** (it would leak secrets into the browser bundle).
 * Getters (not constants) so tests can set process.env before use.
 */
const req = (name: string): string => {
  const v = process.env[name]
  if (!v) throw new Error(`Missing environment variable ${name} (see .env.example)`)
  return v
}
const opt = (name: string, fallback = ''): string => process.env[name] || fallback

export const env = {
  get appUrl() { return opt('APP_URL', 'http://localhost:3000').replace(/\/$/, '') },
  get demoMode() { return opt('DEMO_MODE', 'true') !== 'false' },
  get cronSecret() { return req('CRON_SECRET') },

  get supabaseUrl() { return req('SUPABASE_URL') },
  /** New Supabase projects call it "secret key"; older ones "service_role key". Either works. */
  get supabaseServiceKey() { return process.env.SUPABASE_SECRET_KEY || req('SUPABASE_SERVICE_KEY') },

  get googleApiKey() { return req('GOOGLE_GENERATIVE_AI_API_KEY') },
  get aiModelSmart() { return opt('AI_MODEL_SMART', 'gemini-flash-latest') },
  get aiModelFast() { return opt('AI_MODEL_FAST', 'gemini-flash-lite-latest') },

  get paypalClientId() { return req('PAYPAL_CLIENT_ID') },
  get paypalClientSecret() { return req('PAYPAL_CLIENT_SECRET') },
  get paypalApiBase() { return opt('PAYPAL_API_BASE', 'https://api-m.sandbox.paypal.com') },
  get paypalWebhookId() { return opt('PAYPAL_WEBHOOK_ID') },

  get channel3ApiKey() { return req('CHANNEL3_API_KEY') },

  get telegramBotToken() { return req('TELEGRAM_BOT_TOKEN') },
  get telegramBotUsername() { return opt('TELEGRAM_BOT_USERNAME') },
  get telegramWebhookSecret() { return req('TELEGRAM_WEBHOOK_SECRET') },

  get demoEmail() { return opt('DEMO_EMAIL', 'demo@dealhound.test') },
  get demoPassword() { return opt('DEMO_PASSWORD', 'dealhound-demo') },
}
