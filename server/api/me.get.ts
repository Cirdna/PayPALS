import { db, unwrap } from '~~/server/lib/db'
import { env } from '~~/server/lib/env'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const profile = unwrap(await db().from('profiles').select('display_name, telegram_chat_id, telegram_link_token').eq('id', user.id).maybeSingle(), 'load profile') as Record<string, any> | null
  const bot = env.telegramBotUsername
  return {
    id: user.id,
    email: user.email,
    displayName: profile?.display_name ?? user.email ?? 'You',
    telegramLinked: !!profile?.telegram_chat_id,
    telegramStartUrl: bot && profile?.telegram_link_token ? `https://t.me/${bot}?start=${profile.telegram_link_token}` : null,
    isDemo: user.email === env.demoEmail,
  }
})
