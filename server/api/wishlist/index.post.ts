import { createWishlistItem, wishlistSchema } from '~~/server/lib/deals'

export default defineEventHandler(async (event) => {
  const user = await requireUser(event)
  const parsed = wishlistSchema.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: parsed.error.issues[0]?.message ?? 'Invalid wishlist item' })
  return createWishlistItem(user.id, parsed.data)
})
