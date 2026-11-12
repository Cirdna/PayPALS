// Owner: C ("grid").
import type { DealRow, Mandate, ScanResponse, WishlistItem } from '#shared/types'

/** Debounces `fn` (trailing edge) and cancels a pending call on unmount. */
export function useDebounced(fn: () => void, ms = 500) {
  let timer: ReturnType<typeof setTimeout> | null = null
  onUnmounted(() => {
    if (timer) clearTimeout(timer)
  })
  return () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(fn, ms)
  }
}

function errorMessage(e: unknown): string {
  const err = e as { data?: { statusMessage?: string }; statusMessage?: string; message?: string }
  return err?.data?.statusMessage ?? err?.statusMessage ?? err?.message ?? 'Unknown error'
}

/** Deals board data: GET /api/deals, refreshed on Realtime changes, plus a sequential "Scan now". */
export function useDeals() {
  const toast = useToast()
  const { data, refresh, status, error } = useFetch<DealRow[]>('/api/deals', { default: () => [], server: false })
  const rows = computed<DealRow[]>(() => data.value ?? [])

  const debouncedRefresh = useDebounced(() => {
    void refresh()
  }, 500)
  useRealtime('matches', debouncedRefresh)

  const scanning = ref(false)
  const progress = ref('')

  /** One POST /api/scan per active wishlist item, strictly one after another. */
  async function scanAll() {
    if (scanning.value) return
    scanning.value = true
    progress.value = 'Loading wishlist…'
    try {
      const wishlist = await $fetch<{ item: WishlistItem; mandate: Mandate | null }[]>('/api/wishlist')
      const active = wishlist.filter((w) => w.item.status === 'active')
      if (active.length === 0) {
        toast.add({
          title: 'Nothing to scan',
          description: 'Add an active item to your wishlist first.',
          color: 'warning',
        })
        return
      }
      let created = 0
      let flagged = 0
      for (const [i, w] of active.entries()) {
        progress.value = `Scanning ${i + 1} / ${active.length}…`
        try {
          const res = await $fetch<ScanResponse>('/api/scan', {
            method: 'POST',
            body: { wishlistItemId: w.item.id },
          })
          created += res?.matchesCreated ?? 0
          flagged += res?.flagged ?? 0
        } catch (e) {
          toast.add({ title: `Scan failed for "${w.item.title}"`, description: errorMessage(e), color: 'error' })
        }
        // Show new rows as soon as each item is done.
        await refresh()
      }
      toast.add({
        title: 'Scan complete',
        description: `${created} new match${created === 1 ? '' : 'es'}${flagged ? `, ${flagged} flagged` : ''}.`,
        color: 'success',
      })
    } catch (e) {
      toast.add({ title: 'Could not start the scan', description: errorMessage(e), color: 'error' })
    } finally {
      scanning.value = false
      progress.value = ''
      await refresh()
    }
  }

  return { rows, refresh, status, error, scanning, progress, scanAll }
}
