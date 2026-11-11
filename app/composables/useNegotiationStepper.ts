// Owner: C ("pages").
import type { Ref } from 'vue'
import type { NegotiationStepResponse } from '#shared/types'

/** Drives a negotiation one round at a time while the page is open. Sequential: waits for each response before the next call. */
export function useNegotiationStepper(
  negotiationId: Ref<string | null> | Readonly<Ref<string | null>>,
  isActive: Ref<boolean> | Readonly<Ref<boolean>>,
  onStep: (r: NegotiationStepResponse) => void,
) {
  const running = ref(false)
  const error = ref<string | null>(null)
  let stopped = false
  let failures = 0

  async function loop() {
    if (!import.meta.client || running.value) return
    running.value = true
    while (!stopped && negotiationId.value && isActive.value && failures < 3) {
      if (document.visibilityState === 'visible') {
        try {
          const r = await $fetch<NegotiationStepResponse>(`/api/negotiations/${negotiationId.value}/step`, { method: 'POST' })
          failures = 0
          error.value = null
          onStep(r)
          if (r.done) break
        } catch (e) {
          const err = e as { data?: { statusMessage?: string }; message?: string }
          failures++
          error.value = err?.data?.statusMessage ?? err?.message ?? 'Step failed'
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
    running.value = false
  }

  watch(
    [negotiationId, isActive],
    () => {
      if (negotiationId.value && isActive.value) {
        failures = 0
        void loop()
      }
    },
    { immediate: true },
  )
  onUnmounted(() => {
    stopped = true
  })

  return {
    running,
    error,
    /** Clears the error and starts stepping again after 3 consecutive failures. */
    retry: () => {
      failures = 0
      error.value = null
      void loop()
    },
  }
}
