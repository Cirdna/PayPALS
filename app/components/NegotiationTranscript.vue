<script setup lang="ts">
// Owner: C ("pages"). Live transcript. Seller messages are untrusted text: plain interpolation only, never raw HTML.
import type { NegotiationMessage } from '#shared/types'
import { formatMoney } from '#shared/utils/money'

const props = defineProps<{ messages: NegotiationMessage[]; running: boolean }>()

const ACTION_LABEL: Record<string, string> = {
  offer: 'Offer',
  counter: 'Counter-offer',
  accept: 'Accepted',
  reject: 'Rejected',
  walk_away: 'Walked away',
  blocked: 'Blocked',
  flagged: 'Flagged',
}

const scroller = ref<HTMLElement | null>(null)

// Scroll inside the transcript box (not the whole page) whenever a message arrives.
watch(
  () => [props.messages.length, props.running],
  async () => {
    await nextTick()
    const el = scroller.value
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  },
  { flush: 'post' },
)
onMounted(() => {
  const el = scroller.value
  if (el) el.scrollTop = el.scrollHeight
})

const guardrailTitle = (m: NegotiationMessage) => (m.action === 'blocked' ? 'Blocked by guardrail' : 'Manipulation attempt detected')
</script>

<template>
  <div ref="scroller" class="max-h-[30rem] space-y-4 overflow-y-auto px-4 py-4 sm:px-5" aria-live="polite">
    <p v-if="messages.length === 0 && !running" class="py-6 text-center text-sm text-muted">No messages yet.</p>

    <template v-for="m in messages" :key="m.id">
      <div v-if="m.role === 'guardrail'" class="space-y-1.5">
        <UAlert
          color="error"
          variant="subtle"
          icon="i-lucide-shield-alert"
          :title="guardrailTitle(m)"
          :description="m.message"
        />
        <div v-if="m.guardrail?.violations?.length" class="flex flex-wrap gap-1.5 pl-1">
          <UBadge v-for="(v, i) in m.guardrail.violations" :key="i" color="error" variant="outline" size="sm">
            {{ v.code }}
          </UBadge>
        </div>
      </div>

      <div v-else class="flex flex-col gap-1" :class="m.role === 'buyer' ? 'items-end' : 'items-start'">
        <div class="flex items-center gap-2 text-xs text-muted" :class="m.role === 'buyer' ? 'flex-row-reverse' : ''">
          <UIcon :name="m.role === 'buyer' ? 'i-lucide-bot' : 'i-lucide-store'" class="size-3.5" />
          <span class="font-medium">{{ m.role === 'buyer' ? 'Your agent' : 'Seller' }}</span>
          <span>Round {{ m.round }}</span>
        </div>
        <div
          class="max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm sm:max-w-[80%]"
          :class="
            m.role === 'buyer'
              ? 'rounded-tr-sm border border-primary/25 bg-primary/10 text-highlighted'
              : 'rounded-tl-sm border border-default bg-muted text-default'
          "
        >
          <div class="mb-1 flex flex-wrap items-center gap-1.5" :class="m.role === 'buyer' ? 'justify-end' : ''">
            <UBadge color="neutral" variant="outline" size="sm">{{ ACTION_LABEL[m.action] ?? m.action }}</UBadge>
            <UBadge v-if="m.price != null" :color="m.role === 'buyer' ? 'primary' : 'neutral'" variant="subtle" size="sm" class="tabular-nums">
              {{ formatMoney(m.price) }}
            </UBadge>
          </div>
          <p class="whitespace-pre-line break-words">{{ m.message }}</p>
        </div>
      </div>
    </template>

    <div v-if="running" class="flex items-center gap-2 text-xs text-muted">
      <span class="flex gap-1" aria-hidden="true">
        <span class="size-1.5 animate-pulse rounded-full bg-primary" />
        <span class="size-1.5 animate-pulse rounded-full bg-primary [animation-delay:200ms]" />
        <span class="size-1.5 animate-pulse rounded-full bg-primary [animation-delay:400ms]" />
      </span>
      Your agent is negotiating…
    </div>
  </div>
</template>
