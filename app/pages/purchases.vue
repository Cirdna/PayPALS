<script setup lang="ts">
// Owner: C ("pages"). Purchase history: totals + AG Grid of completed PayPal payments.
import { formatMoney } from '#shared/utils/money'
import type { Purchase } from '~/utils/purchases'

useHead({ title: 'Purchases · DealHound' })

const { data, refresh, status, error } = useFetch<Purchase[]>('/api/deals/purchases', { default: () => [], server: false })
const rows = computed<Purchase[]>(() => data.value ?? [])
const loaded = computed(() => status.value === 'success' || status.value === 'error')

// A capture flips the match to `purchased`, so match changes are the signal to reload.
const debouncedRefresh = useDebounced(() => {
  void refresh()
}, 500)
useRealtime('matches', debouncedRefresh)

const search = ref('')

const stats = computed(() => {
  const t = purchaseTotals(rows.value)
  return [
    { label: 'Total spent', value: formatMoney(t.spent), icon: 'i-lucide-wallet', tone: '' },
    { label: 'Saved vs. list price', value: t.saved > 0 ? formatMoney(t.saved) : '—', icon: 'i-lucide-piggy-bank', tone: 'text-success' },
    { label: 'Purchases', value: String(t.count), icon: 'i-lucide-receipt', tone: '' },
  ]
})

const open = (matchId: string) => navigateTo(`/deals/${matchId}`)
</script>

<template>
  <UContainer class="max-w-[1600px] space-y-6 py-8">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Purchases</h1>
        <p class="mt-1 text-sm text-muted">
          Everything you bought through DealHound with PayPal. Open one to see how the agent negotiated it.
        </p>
      </div>
      <UInput v-model="search" icon="i-lucide-search" placeholder="Search purchases…" class="w-56" />
    </div>

    <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div v-for="s in stats" :key="s.label" class="rounded-lg border border-default bg-default px-4 py-3">
        <p class="flex items-center gap-1.5 text-xs text-muted">
          <UIcon :name="s.icon" class="size-3.5" />
          {{ s.label }}
        </p>
        <p class="mt-1 text-xl font-semibold tabular-nums" :class="s.tone">{{ loaded ? s.value : '…' }}</p>
      </div>
    </div>

    <UAlert
      v-if="status === 'error'"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="Could not load your purchases"
      :description="error?.statusMessage || error?.message || 'Please try again.'"
    />

    <div v-else-if="loaded && rows.length === 0" class="rounded-lg border border-dashed border-default px-6 py-16 text-center">
      <UIcon name="i-lucide-receipt" class="mx-auto size-10 text-dimmed" />
      <h2 class="mt-3 text-lg font-semibold">No purchases yet</h2>
      <p class="mx-auto mt-1 max-w-sm text-sm text-muted">
        When you approve a deal and pay with PayPal, it moves here from the Deals board.
      </p>
      <UButton class="mt-5" to="/deals" icon="i-lucide-tags">Go to Deals</UButton>
    </div>

    <ClientOnly v-else>
      <PurchasesGrid v-if="loaded" :rows="rows" :quick-filter-text="search" @open="open" />
      <div v-else class="space-y-2">
        <USkeleton class="h-10 w-full" />
        <USkeleton v-for="i in 3" :key="i" class="h-12 w-full" />
      </div>
      <template #fallback>
        <div class="space-y-2">
          <USkeleton class="h-10 w-full" />
          <USkeleton v-for="i in 3" :key="i" class="h-12 w-full" />
        </div>
      </template>
    </ClientOnly>
  </UContainer>
</template>
