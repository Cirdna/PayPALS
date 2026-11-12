// Owner: C ("grid").
import type { Ref } from 'vue'
import type { DealRow } from '#shared/types'

/**
 * While mounted: every 2.5 s take the first row that is `negotiating` and advance it by one round.
 * Sequential, never overlapping, only while the tab is visible. `onStepped` runs after each successful step so the
 * board can refresh even when Realtime is not available.
 */
export function useBackgroundStepper(rows: Readonly<Ref<DealRow[]>>, onStepped?: () => void) {
  let stopped = false
  const ids = new Map<string, string>() // matchId -> negotiationId

  async function loop() {
    while (!stopped) {
      const row = document.visibilityState === 'visible' ? rows.value.find((r) => r.status === 'negotiating') : undefined
      if (row) {
        try {
          if (!ids.has(row.matchId)) {
            const n = await $fetch<{ id: string }>(`/api/matches/${row.matchId}/negotiate`, { method: 'POST' })
            ids.set(row.matchId, n.id)
          }
          await $fetch(`/api/negotiations/${ids.get(row.matchId)}/step`, { method: 'POST' })
          onStepped?.()
        } catch {
          /* the deal page shows errors; the board just retries */
        }
      }
      await new Promise((r) => setTimeout(r, 2500))
    }
  }

  onMounted(() => {
    void loop()
  })
  onUnmounted(() => {
    stopped = true
  })
}
