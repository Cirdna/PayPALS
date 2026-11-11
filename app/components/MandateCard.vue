<script setup lang="ts">
// Owner: C ("pages"). Shows the spending mandate that bounds the agent.
import type { Mandate } from '#shared/types'
import { formatMoney } from '#shared/utils/money'

const props = defineProps<{ mandate: Mandate | null }>()

const state = computed<'none' | 'revoked' | 'expired' | 'active'>(() => {
  const m = props.mandate
  if (!m) return 'none'
  if (m.revokedAt) return 'revoked'
  if (new Date(m.expiresAt).getTime() <= Date.now()) return 'expired'
  return 'active'
})

const until = computed(() =>
  props.mandate
    ? new Date(props.mandate.expiresAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '',
)
</script>

<template>
  <div
    class="flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm"
    :class="state === 'active' ? 'border-success/30 bg-success/10' : 'border-warning/40 bg-warning/10'"
  >
    <UIcon
      :name="state === 'active' ? 'i-lucide-shield-check' : 'i-lucide-shield-alert'"
      class="mt-0.5 size-5 shrink-0"
      :class="state === 'active' ? 'text-success' : 'text-warning'"
    />
    <div v-if="mandate && state === 'active'" class="min-w-0">
      <p class="text-highlighted">
        Agent may spend up to <span class="font-semibold tabular-nums">{{ formatMoney(mandate.maxAmount, mandate.currency) }}</span>
      </p>
      <p class="text-xs text-muted">
        Valid until {{ until }}
        <template v-if="mandate.requireHumanApproval"> · your approval is required for every payment</template>
      </p>
    </div>
    <div v-else-if="mandate" class="min-w-0">
      <p class="font-medium text-highlighted">{{ state === 'revoked' ? 'Mandate revoked' : 'Mandate expired' }}</p>
      <p class="text-xs text-muted">The agent will not negotiate or pay until you create a new mandate.</p>
    </div>
    <div v-else class="min-w-0">
      <p class="font-medium text-highlighted">No mandate</p>
      <p class="text-xs text-muted">The agent has no permission to spend for this item.</p>
    </div>
  </div>
</template>
