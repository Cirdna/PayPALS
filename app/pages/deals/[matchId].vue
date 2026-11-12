<script setup lang="ts">
// Owner: C ("pages"). Deal page: price, mandate, scam check with evidence, live negotiation, actions.
// Seller / listing text is untrusted: plain interpolation only, never raw HTML.
import type { CheckoutCreateResponse, MatchDetail, Negotiation } from '#shared/types'
import { formatMoney } from '#shared/utils/money'

const route = useRoute()
const config = useRuntimeConfig()
const matchId = String(route.params.matchId)

const { data: detail, refresh, error, status: fetchStatus } = useFetch<MatchDetail>(`/api/deals/${matchId}`, {
  server: false,
})

const debouncedRefresh = useDebounced(() => {
  void refresh()
}, 300)
useRealtime('matches', debouncedRefresh, `id=eq.${matchId}`)
useRealtime('negotiation_messages', debouncedRefresh)

const match = computed(() => detail.value?.match ?? null)
const listing = computed(() => detail.value?.listing ?? null)
const seller = computed(() => detail.value?.seller ?? null)
const item = computed(() => detail.value?.wishlistItem ?? null)
const negotiation = computed(() => detail.value?.negotiation ?? null)
const order = computed(() => detail.value?.order ?? null)
const state = computed(() => match.value?.status ?? null)

const notFound = computed(() => fetchStatus.value === 'error' && error.value?.statusCode === 404)
const loadFailed = computed(() => fetchStatus.value === 'error' && !notFound.value)
const loading = computed(() => !detail.value && fetchStatus.value !== 'error')

// ───────── negotiation stepper
const negotiationId = computed(() => negotiation.value?.id ?? null)
const negotiationActive = computed(() => negotiation.value?.status === 'active')
const stepper = useNegotiationStepper(negotiationId, negotiationActive, () => {
  void refresh()
})

// A match can be `negotiating` without us holding the negotiation yet (e.g. started from the board). The call is idempotent.
const ensuring = ref(false)
watch(
  [state, negotiation],
  async () => {
    if (state.value === 'negotiating' && !negotiation.value && !ensuring.value) {
      ensuring.value = true
      await $fetch<Negotiation>(`/api/matches/${matchId}/negotiate`, { method: 'POST' }).catch(() => null)
      await refresh()
      ensuring.value = false
    }
  },
  { immediate: true },
)

// ───────── derived display values
const bestPrice = computed(() => match.value?.bestPrice ?? listing.value?.price ?? 0)
const listPrice = computed(() => listing.value?.price ?? 0)
const saving = computed(() => Math.max(0, listPrice.value - bestPrice.value))
const underLimit = computed(() => (item.value ? item.value.maxPrice - bestPrice.value : 0))
const payable = computed(() => listing.value?.source === 'marketplace')
// A paused or already-fulfilled wishlist item can no longer be paid for.
const itemActive = computed(() => item.value?.status === 'active')
const showImage = computed(() => !config.public.demoMode && !!listing.value?.imageUrl)

const sellerLine = computed(() => {
  if (listing.value?.source === 'channel3') return listing.value.retailer ?? 'Retailer'
  return seller.value?.displayName ?? 'Unknown seller'
})
const accountAge = computed(() => {
  const d = seller.value?.accountAgeDays
  if (d == null) return null
  if (d < 60) return `${d} day${d === 1 ? '' : 's'} on the platform`
  if (d < 730) return `${Math.round(d / 30)} months on the platform`
  return `${Math.round(d / 365)} years on the platform`
})

const negotiable = computed(() => !!listing.value?.negotiable)
const canSkip = computed(() => ['ready', 'agreed', 'notified', 'no_deal'].includes(state.value ?? ''))

// ───────── actions
const acting = ref<null | 'negotiate' | 'pay' | 'skip'>(null)

async function negotiate() {
  acting.value = 'negotiate'
  await api<Negotiation>(`/api/matches/${matchId}/negotiate`, { method: 'POST' })
  await refresh()
  acting.value = null
}

async function approveAndPay() {
  acting.value = 'pay'
  const res = await api<CheckoutCreateResponse>('/api/checkout', { method: 'POST', body: { matchId } })
  if (res?.approveUrl) {
    window.location.href = res.approveUrl // keep the loading state while the browser leaves
    return
  }
  acting.value = null
}

function continueToPayPal() {
  if (order.value?.approveUrl) window.location.href = order.value.approveUrl
}

async function skip() {
  acting.value = 'skip'
  const ok = await apiOk(`/api/deals/${matchId}/skip`, { method: 'POST' })
  if (ok) {
    await navigateTo('/deals')
    return
  }
  acting.value = null
}

useHead({ title: computed(() => (listing.value ? `${listing.value.title} · DealHound` : 'Deal · DealHound')) })
</script>

<template>
  <UContainer class="space-y-5 py-6 pb-28 sm:py-8 sm:pb-8">
    <UButton to="/deals" variant="link" color="neutral" icon="i-lucide-arrow-left" class="-ml-2.5">All deals</UButton>

    <!-- payment result banners -->
    <UAlert
      v-if="route.query.paid === '1'"
      color="success"
      variant="subtle"
      icon="i-lucide-party-popper"
      title="Payment captured — it's yours."
      description="PayPal confirmed the payment at the agreed price."
    />
    <UAlert
      v-else-if="route.query.cancelled === '1'"
      color="info"
      variant="subtle"
      icon="i-lucide-info"
      title="Payment cancelled"
      description="You were not charged. You can approve the deal again whenever you are ready."
    />
    <UAlert
      v-else-if="route.query.failed === '1'"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-x"
      title="PayPal did not complete the payment."
      description="You were not charged."
    />

    <!-- loading -->
    <div v-if="loading" class="space-y-4">
      <USkeleton class="h-36 w-full rounded-xl" />
      <div class="grid gap-4 lg:grid-cols-2">
        <USkeleton class="h-64 w-full rounded-xl" />
        <USkeleton class="h-64 w-full rounded-xl" />
      </div>
    </div>

    <!-- not found / failed -->
    <div v-else-if="notFound" class="rounded-xl border border-dashed border-default px-6 py-16 text-center">
      <UIcon name="i-lucide-search-x" class="mx-auto size-10 text-dimmed" />
      <h1 class="mt-3 text-lg font-semibold">Deal not found</h1>
      <p class="mt-1 text-sm text-muted">It may have been removed, or it belongs to another account.</p>
      <UButton to="/deals" class="mt-5" icon="i-lucide-arrow-left">Back to deals</UButton>
    </div>
    <UAlert
      v-else-if="loadFailed"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="Could not load this deal"
      :description="error?.statusMessage || error?.message || 'Please try again.'"
      :actions="[{ label: 'Retry', color: 'error', variant: 'outline', onClick: () => refresh() }]"
    />

    <template v-else-if="detail && match && listing && item">
      <!-- header + price -->
      <section class="rounded-xl border border-default bg-default">
        <div class="flex flex-col gap-5 p-4 sm:p-5 md:flex-row md:items-start md:justify-between">
          <div class="flex min-w-0 gap-4">
            <img
              v-if="showImage"
              :src="listing.imageUrl ?? undefined"
              alt=""
              class="size-20 shrink-0 rounded-lg border border-default object-cover sm:size-24"
            />
            <div
              v-else
              class="flex size-20 shrink-0 items-center justify-center rounded-lg border border-default bg-muted sm:size-24"
            >
              <UIcon name="i-lucide-package" class="size-8 text-dimmed" />
            </div>
            <div class="min-w-0 space-y-2">
              <p class="text-xs font-medium uppercase tracking-wide text-muted">For: {{ item.title }}</p>
              <h1 class="break-words text-xl font-semibold leading-tight tracking-tight text-highlighted sm:text-2xl">
                {{ listing.title }}
              </h1>
              <div class="flex flex-wrap items-center gap-2">
                <StatusChip :status="match.status" />
                <RiskBadge :level="match.risk?.level ?? null" :score="match.risk?.score ?? null" />
              </div>
              <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
                <span class="inline-flex items-center gap-1">
                  <UIcon :name="payable ? 'i-lucide-store' : 'i-lucide-shopping-bag'" class="size-3.5" />
                  {{ sellerLine }}
                </span>
                <span v-if="payable && seller?.rating != null" class="inline-flex items-center gap-1">
                  <UIcon name="i-lucide-star" class="size-3.5 text-warning" />
                  {{ seller.rating.toFixed(1) }} ({{ seller.ratingCount }})
                </span>
                <span v-if="payable && accountAge" class="inline-flex items-center gap-1">
                  <UIcon name="i-lucide-calendar-clock" class="size-3.5" />
                  {{ accountAge }}
                </span>
                <span v-if="listing.condition" class="inline-flex items-center gap-1">
                  <UIcon name="i-lucide-sparkles" class="size-3.5" />
                  {{ CONDITION_LABEL[listing.condition] }}
                </span>
                <span class="inline-flex items-center gap-1">
                  <UIcon name="i-lucide-tag" class="size-3.5" />
                  {{ SOURCE_LABEL[listing.source] }}
                </span>
              </div>
            </div>
          </div>

          <div class="shrink-0 rounded-lg bg-muted px-4 py-3 md:min-w-56 md:text-right">
            <p class="text-xs text-muted">{{ saving > 0 ? 'Best price' : 'Price' }}</p>
            <p class="flex items-baseline gap-2 md:justify-end">
              <span v-if="saving > 0" class="text-sm text-muted line-through tabular-nums">{{ formatMoney(listPrice) }}</span>
              <span class="text-3xl font-bold tracking-tight text-highlighted tabular-nums">{{ formatMoney(bestPrice) }}</span>
            </p>
            <p v-if="saving > 0" class="mt-0.5 text-sm font-medium text-success tabular-nums">You save {{ formatMoney(saving) }}</p>
            <p class="mt-0.5 text-xs tabular-nums" :class="underLimit >= 0 ? 'text-muted' : 'text-error'">
              {{ formatMoney(Math.abs(underLimit)) }} {{ underLimit >= 0 ? 'under' : 'over' }} your {{ formatMoney(item.maxPrice) }} limit
            </p>
          </div>
        </div>
        <div class="border-t border-default p-4 sm:px-5">
          <MandateCard :mandate="detail.mandate" />
        </div>
      </section>

      <div class="grid gap-5 lg:grid-cols-2">
        <!-- negotiation -->
        <section class="min-w-0 rounded-xl border border-default bg-default">
          <div class="flex items-center justify-between gap-3 px-4 pt-4 sm:px-5">
            <h2 class="flex items-center gap-2 text-sm font-semibold text-highlighted">
              <UIcon name="i-lucide-messages-square" class="size-4 text-muted" />
              Negotiation
            </h2>
            <UBadge v-if="negotiation" :color="negotiation.status === 'agreed' ? 'success' : negotiation.status === 'no_deal' ? 'neutral' : 'primary'" variant="subtle">
              {{ negotiation.status === 'active' ? `Round ${negotiation.round} of ${negotiation.maxRounds}` : negotiation.status === 'agreed' ? 'Agreed' : 'No deal' }}
            </UBadge>
          </div>

          <NegotiationTranscript
            v-if="negotiation"
            :messages="detail.messages"
            :running="stepper.running.value && negotiationActive"
          />
          <div v-else class="px-4 pb-5 pt-4 text-sm text-muted sm:px-5">
            <template v-if="state === 'flagged'">Flagged listings are never negotiated.</template>
            <template v-else-if="!negotiable">This is a fixed price — there is nothing to negotiate.</template>
            <template v-else-if="state === 'ready'">
              Press <span class="font-medium text-default">Negotiate</span> and your agent will haggle with the seller, never going above
              {{ formatMoney(item.maxPrice) }}.
            </template>
            <template v-else>No negotiation took place.</template>
          </div>

          <div v-if="stepper.error.value" class="px-4 pb-4 sm:px-5">
            <UAlert
              color="warning"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              title="The negotiation paused"
              :description="stepper.error.value"
              :actions="[{ label: 'Retry', color: 'warning', variant: 'outline', onClick: () => stepper.retry() }]"
            />
          </div>
        </section>

        <!-- risk -->
        <RiskEvidence :risk="match.risk" :list-price="listPrice" class="min-w-0 self-start" />
      </div>

      <!-- description (untrusted text, rendered as plain text) -->
      <section v-if="listing.description" class="rounded-xl border border-default bg-default p-4 sm:p-5">
        <h2 class="mb-2 flex items-center gap-2 text-sm font-semibold text-highlighted">
          <UIcon name="i-lucide-file-text" class="size-4 text-muted" />
          Listing description
        </h2>
        <p class="whitespace-pre-line break-words text-sm text-default">{{ listing.description }}</p>
      </section>

      <!-- actions -->
      <div class="sticky bottom-3 z-10 space-y-3 rounded-xl border border-default bg-default/95 p-3 shadow-lg backdrop-blur sm:static sm:bg-default sm:shadow-none">
        <UAlert
          v-if="state === 'flagged'"
          color="error"
          variant="subtle"
          icon="i-lucide-shield-alert"
          title="DealHound will not negotiate or pay for flagged listings."
          description="The scam check found too many warning signs. Review the evidence above."
        />
        <UAlert
          v-else-if="state === 'purchased'"
          color="success"
          variant="subtle"
          icon="i-lucide-circle-check"
          :title="`Purchased for ${formatMoney(order?.amount ?? bestPrice)}`"
          description="Paid with PayPal. Nothing more to do."
        />
        <UAlert
          v-else-if="(state === 'agreed' || state === 'notified') && payable && !itemActive"
          color="warning"
          variant="subtle"
          icon="i-lucide-pause-circle"
          :title="item?.status === 'fulfilled' ? 'This wish is already fulfilled' : 'This wishlist item is paused'"
          description="The agent will not pay for it. Reactivate the item to buy this deal."
        />
        <p v-else-if="state === 'negotiating'" class="flex items-center gap-2 text-sm text-muted">
          <UIcon name="i-lucide-loader-circle" class="size-4 animate-spin text-primary" />
          Your agent is negotiating. You will be asked to approve before any money moves.
        </p>
        <p v-else-if="state === 'over_budget'" class="text-sm text-muted">
          This is above your {{ formatMoney(item.maxPrice) }} limit, so the agent will not buy it. It is kept as a price reference.
        </p>
        <p v-else-if="state === 'no_deal'" class="text-sm text-muted">The seller would not come down to your limit.</p>
        <p v-else-if="state === 'skipped'" class="text-sm text-muted">You skipped this deal.</p>

        <div class="flex flex-wrap items-center gap-2">
          <UButton
            v-if="state === 'ready'"
            size="lg"
            icon="i-lucide-handshake"
            class="flex-1 justify-center sm:flex-none"
            :loading="acting === 'negotiate'"
            :disabled="acting !== null"
            @click="negotiate"
          >
            Negotiate
          </UButton>

          <UButton
            v-if="(state === 'agreed' || state === 'notified') && payable && itemActive"
            size="lg"
            icon="i-lucide-wallet"
            class="flex-1 justify-center sm:flex-none"
            :loading="acting === 'pay'"
            :disabled="acting !== null"
            @click="approveAndPay"
          >
            Approve &amp; pay with PayPal
          </UButton>

          <UButton
            v-if="state === 'checkout_pending' && order?.approveUrl"
            size="lg"
            icon="i-lucide-wallet"
            class="flex-1 justify-center sm:flex-none"
            @click="continueToPayPal"
          >
            Continue to PayPal
          </UButton>

          <UButton
            v-if="(state === 'agreed' || state === 'notified') && !payable"
            size="lg"
            icon="i-lucide-external-link"
            class="flex-1 justify-center sm:flex-none"
            :to="listing.url ?? undefined"
            target="_blank"
            rel="noopener noreferrer"
            :disabled="!listing.url"
          >
            Buy at retailer
          </UButton>

          <UButton
            v-if="canSkip"
            size="lg"
            color="neutral"
            variant="outline"
            icon="i-lucide-skip-forward"
            class="justify-center"
            :loading="acting === 'skip'"
            :disabled="acting !== null"
            @click="skip"
          >
            Skip
          </UButton>
        </div>
      </div>
    </template>
  </UContainer>
</template>
