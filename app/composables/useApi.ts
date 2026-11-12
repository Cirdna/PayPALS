// Owner: C ("pages"). Thin $fetch wrappers that turn failures into an error toast instead of an exception.
type ApiOptions = { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: Record<string, unknown>; query?: Record<string, unknown> }

// Plain signature: Nuxt's typed `$fetch` route inference is too deep for a generic wrapper.
const rawFetch = $fetch as unknown as (url: string, opts?: unknown) => Promise<unknown>

// Plain-language messages for the machine codes the checkout and negotiation routes send in `data.code`.
const CODE_TEXT: Record<string, string> = {
  checkout_in_progress: 'A payment for this deal is already in progress. Use "Continue to PayPal" or wait a moment.',
  not_allowed: 'This deal cannot be paid right now: the wishlist item is paused or already fulfilled.',
  not_payable: 'This is a retailer listing. Use "Buy at retailer" to purchase it.',
  exceeds_mandate: 'The price is above your spending mandate, so the agent will not pay it.',
  mandate_expired: 'Your spending mandate has expired. Add the item to your wishlist again to renew it.',
}

function errorText(e: unknown): string {
  const err = e as { data?: { statusMessage?: string; message?: string; data?: { code?: string } }; statusMessage?: string; message?: string }
  const code = err?.data?.data?.code
  if (code && CODE_TEXT[code]) return CODE_TEXT[code]
  return err?.data?.statusMessage ?? err?.statusMessage ?? err?.data?.message ?? err?.message ?? 'Unknown error'
}

/** Calls the API; on failure shows an error toast and returns `null`. Use `apiOk` for routes that answer 204 (no body). */
export async function api<T>(url: string, opts?: ApiOptions): Promise<T | null> {
  try {
    return ((await rawFetch(url, opts)) as T | null | undefined) ?? null
  } catch (e) {
    useToast().add({ title: 'Something went wrong', description: errorText(e), color: 'error' })
    return null
  }
}

/** Like `api`, but returns whether the call succeeded (for 204 responses). */
export async function apiOk(url: string, opts?: ApiOptions): Promise<boolean> {
  try {
    await rawFetch(url, opts)
    return true
  } catch (e) {
    useToast().add({ title: 'Something went wrong', description: errorText(e), color: 'error' })
    return false
  }
}
