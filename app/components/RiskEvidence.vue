<script setup lang="ts">
// Owner: C ("pages"). Risk card: score, explanation, price statistics, every signal with the quoted evidence.
// Evidence is seller text (untrusted): plain interpolation only, never raw HTML.
import type { RiskAssessment, RiskSignalCode } from '#shared/types'
import { formatMoney } from '#shared/utils/money'

const props = defineProps<{ risk: RiskAssessment | null; listPrice: number }>()

const SIGNAL_TITLE: Record<RiskSignalCode, string> = {
  price_anomaly: 'Price far below market',
  off_platform_payment: 'Asks to pay outside the platform',
  deposit_request: 'Asks for money upfront',
  urgency_pressure: 'Pressure tactics',
  new_account: 'Brand-new seller account',
  low_rating: 'Low seller rating',
  suspicious_link: 'Suspicious link',
  duplicate_text: 'Listing text reused elsewhere',
  condition_mismatch: 'Condition does not add up',
}

const BAR_CLASS = { low: 'bg-success', medium: 'bg-warning', high: 'bg-error' } as const
const CARD_CLASS = { low: 'border-default', medium: 'border-warning/40', high: 'border-error/40' } as const

const stats = computed(() => {
  const s = props.risk?.priceStats
  if (!s) return null
  return `${Math.round(s.pctOfMedian * 100)}% of the median of ${s.compsCount} retail offers (${formatMoney(s.median)})`
})
const weight = (w: number) => (w > 0 ? `+${w}` : String(w))
const score = computed(() => Math.max(0, Math.min(100, props.risk?.score ?? 0)))
</script>

<template>
  <section class="rounded-xl border bg-default" :class="risk ? CARD_CLASS[risk.level] : 'border-default'">
    <div class="flex items-center justify-between gap-3 px-4 pt-4 sm:px-5">
      <h2 class="flex items-center gap-2 text-sm font-semibold text-highlighted">
        <UIcon name="i-lucide-scan-search" class="size-4 text-muted" />
        Scam check
      </h2>
      <RiskBadge v-if="risk" :level="risk.level" :score="risk.score" />
      <UBadge v-else color="neutral" variant="subtle">Not assessed</UBadge>
    </div>

    <div v-if="!risk" class="px-4 pb-4 pt-3 text-sm text-muted sm:px-5">Not assessed yet.</div>

    <div v-else class="space-y-4 px-4 pb-4 pt-3 sm:px-5">
      <div
        class="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label="Risk score"
        :aria-valuenow="score"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div class="h-full rounded-full transition-all" :class="BAR_CLASS[risk.level]" :style="{ width: `${score}%` }" />
      </div>

      <p class="text-sm text-default">{{ risk.explanation }}</p>

      <p v-if="stats" class="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-sm text-default">
        <UIcon name="i-lucide-chart-no-axes-column" class="mt-0.5 size-4 shrink-0 text-muted" />
        <span>
          Listed at <span class="font-semibold tabular-nums">{{ formatMoney(listPrice) }}</span>, which is {{ stats }}.
        </span>
      </p>

      <ul v-if="risk.signals.length" class="space-y-3">
        <li v-for="(s, i) in risk.signals" :key="`${s.code}-${i}`" class="rounded-lg border border-default p-3">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="text-sm font-medium text-highlighted">{{ SIGNAL_TITLE[s.code] ?? s.code }}</p>
              <p class="mt-0.5 text-sm text-muted">{{ s.detail }}</p>
            </div>
            <UBadge :color="s.weight >= 25 ? 'error' : 'warning'" variant="subtle" class="shrink-0 tabular-nums">
              {{ weight(s.weight) }}
            </UBadge>
          </div>
          <blockquote
            v-if="s.evidence"
            class="mt-2 break-words rounded-md border-l-4 border-warning bg-warning/15 px-3 py-2 text-sm italic text-highlighted"
          >
            “{{ s.evidence }}”
          </blockquote>
        </li>
      </ul>
      <p v-else class="flex items-center gap-2 text-sm text-muted">
        <UIcon name="i-lucide-check" class="size-4 text-success" />
        No risk signals found.
      </p>
    </div>
  </section>
</template>
