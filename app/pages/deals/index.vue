<script setup lang="ts">
// Owner: C ("grid"). The Deals board: AG Grid + live activity feed + scan + background negotiation stepper.
import { formatMoney } from '#shared/utils/money'

useHead({ title: 'Deals · DealHound' })

const { rows, refresh, status, error, scanning, progress, scanAll } = useDeals()
useBackgroundStepper(rows, () => {
  void refresh()
})

const search = ref('')
const loaded = computed(() => status.value === 'success' || status.value === 'error')

const stats = computed(() => {
  const list = rows.value
  const approvable = list.filter((r) => r.status === 'agreed' || r.status === 'notified')
  const best = list
    .filter((r) => !['flagged', 'over_budget', 'skipped', 'no_deal'].includes(r.status))
    .reduce((m, r) => Math.max(m, r.savings), 0)
  return [
    { label: 'Deals found', value: String(list.length), icon: 'i-lucide-tags', tone: '' },
    { label: 'Ready for you', value: String(approvable.length), icon: 'i-lucide-bell-ring', tone: 'text-success' },
    {
      label: 'Flagged as risky',
      value: String(list.filter((r) => r.status === 'flagged').length),
      icon: 'i-lucide-shield-alert',
      tone: 'text-error',
    },
    { label: 'Best saving', value: best > 0 ? formatMoney(best) : '—', icon: 'i-lucide-piggy-bank', tone: 'text-success' },
  ]
})

const open = (matchId: string) => navigateTo(`/deals/${matchId}`)
</script>

<template>
  <UContainer class="space-y-6 py-8">
    <div class="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 class="text-2xl font-semibold tracking-tight">Deals</h1>
        <p class="mt-1 text-sm text-muted">
          Everything your agent found, screened for risk and negotiated within your limits.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <UInput v-model="search" icon="i-lucide-search" placeholder="Search deals…" class="w-56" />
        <UButton icon="i-lucide-radar" :loading="scanning" @click="scanAll">
          {{ scanning ? progress || 'Scanning…' : 'Scan now' }}
        </UButton>
      </div>
    </div>

    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div v-for="s in stats" :key="s.label" class="rounded-lg border border-default bg-default px-4 py-3">
        <p class="flex items-center gap-1.5 text-xs text-muted">
          <UIcon :name="s.icon" class="size-3.5" />
          {{ s.label }}
        </p>
        <p class="mt-1 text-xl font-semibold tabular-nums" :class="s.tone">{{ s.value }}</p>
      </div>
    </div>

    <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section class="min-w-0">
        <UAlert
          v-if="status === 'error'"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          title="Could not load your deals"
          :description="error?.statusMessage || error?.message || 'Please try again.'"
          class="mb-4"
        />

        <div v-if="loaded && rows.length === 0 && status !== 'error'" class="rounded-lg border border-dashed border-default px-6 py-16 text-center">
          <UIcon name="i-lucide-radar" class="mx-auto size-10 text-dimmed" />
          <h2 class="mt-3 text-lg font-semibold">No deals yet</h2>
          <p class="mx-auto mt-1 max-w-sm text-sm text-muted">
            Press "Scan now" and your agent will search for your wishlist items, screen the sellers and start haggling.
          </p>
          <UButton class="mt-5" icon="i-lucide-radar" :loading="scanning" @click="scanAll">
            {{ scanning ? progress || 'Scanning…' : 'Scan now' }}
          </UButton>
        </div>

        <ClientOnly v-else-if="status !== 'error'">
          <DealsGrid v-if="loaded" :rows="rows" :quick-filter-text="search" @open="open" />
          <div v-else class="space-y-2">
            <USkeleton class="h-10 w-full" />
            <USkeleton v-for="i in 6" :key="i" class="h-12 w-full" />
          </div>
          <template #fallback>
            <div class="space-y-2">
              <USkeleton class="h-10 w-full" />
              <USkeleton v-for="i in 6" :key="i" class="h-12 w-full" />
            </div>
          </template>
        </ClientOnly>
      </section>

      <aside class="min-w-0">
        <ActivityFeed />
      </aside>
    </div>
  </UContainer>
</template>
