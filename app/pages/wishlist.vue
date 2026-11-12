<script setup lang="ts">
// Owner: C ("pages"). Wishlist: what the agent hunts for, and the mandate that limits what it may spend.
import type { Condition, CreateWishlistRequest, Mandate, WishlistItem, WishlistStatus } from '#shared/types'
import { formatMoney } from '#shared/utils/money'
import type { UiColor } from '~/utils/labels'

useHead({ title: 'Wishlist · DealHound' })

type Entry = { item: WishlistItem; mandate: Mandate | null }
const { data, refresh, status } = useFetch<Entry[]>('/api/wishlist', { default: () => [], server: false })
const entries = computed(() => data.value ?? [])
const loaded = computed(() => status.value === 'success' || status.value === 'error')

const STATUS_CHIP: Record<WishlistStatus, { label: string; color: UiColor; icon: string }> = {
  active: { label: 'Watching', color: 'success', icon: 'i-lucide-radar' },
  paused: { label: 'Paused', color: 'neutral', icon: 'i-lucide-pause' },
  fulfilled: { label: 'Bought', color: 'primary', icon: 'i-lucide-circle-check' },
}

const CONDITION_ITEMS: { label: string; value: Condition }[] = [
  { label: 'New', value: 'new' },
  { label: 'Like new', value: 'like_new' },
  { label: 'Good', value: 'good' },
  { label: 'Fair', value: 'fair' },
]

// ───────── create form
const form = reactive({
  title: '',
  query: '',
  specs: '',
  maxPrice: null as number | null,
  targetPrice: null as number | null,
  minCondition: 'good' as Condition,
  dealbreakers: '',
  days: 14 as number | null,
})
const submitting = ref(false)

const targetError = computed(() =>
  form.targetPrice != null && form.maxPrice != null && form.targetPrice > form.maxPrice
    ? 'Target price must not exceed the maximum price'
    : undefined,
)
const canSubmit = computed(
  () =>
    form.title.trim().length > 0 &&
    form.query.trim().length > 0 &&
    form.maxPrice != null &&
    form.maxPrice > 0 &&
    !targetError.value &&
    (form.days ?? 14) >= 1,
)

async function submit() {
  if (!canSubmit.value || submitting.value) return
  submitting.value = true
  const body: CreateWishlistRequest = {
    title: form.title.trim(),
    query: form.query.trim(),
    specs: form.specs.trim(),
    maxPrice: form.maxPrice as number,
    targetPrice: form.targetPrice ?? null,
    minCondition: form.minCondition,
    dealbreakers: form.dealbreakers
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    mandateExpiresInDays: form.days ?? 14,
  }
  const res = await api<{ item: WishlistItem; mandate: Mandate }>('/api/wishlist', { method: 'POST', body: body as never })
  submitting.value = false
  if (!res) return
  useToast().add({
    title: 'Added to your wishlist',
    description: `Your agent may spend up to ${formatMoney(res.mandate.maxAmount)} on "${res.item.title}".`,
    color: 'success',
  })
  Object.assign(form, { title: '', query: '', specs: '', maxPrice: null, targetPrice: null, minCondition: 'good', dealbreakers: '', days: 14 })
  await refresh()
}

// ───────── delete (two-step confirm, no modal)
const confirmingId = ref<string | null>(null)
const deletingId = ref<string | null>(null)
let confirmTimer: ReturnType<typeof setTimeout> | null = null
onUnmounted(() => {
  if (confirmTimer) clearTimeout(confirmTimer)
})

async function remove(id: string) {
  if (confirmingId.value !== id) {
    confirmingId.value = id
    if (confirmTimer) clearTimeout(confirmTimer)
    confirmTimer = setTimeout(() => (confirmingId.value = null), 4000)
    return
  }
  confirmingId.value = null
  deletingId.value = id
  const ok = await apiOk(`/api/wishlist/${id}`, { method: 'DELETE' })
  deletingId.value = null
  if (ok) {
    useToast().add({ title: 'Removed from your wishlist', color: 'neutral' })
    await refresh()
  }
}
</script>

<template>
  <UContainer class="space-y-6 py-8">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Wishlist</h1>
      <p class="mt-1 text-sm text-muted">
        Tell your agent what to hunt for. Each item comes with a spending mandate: a hard limit it can never exceed.
      </p>
    </div>

    <div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <!-- list -->
      <section class="min-w-0 space-y-4">
        <template v-if="!loaded">
          <USkeleton v-for="i in 3" :key="i" class="h-44 w-full rounded-xl" />
        </template>

        <div v-else-if="entries.length === 0" class="rounded-xl border border-dashed border-default px-6 py-16 text-center">
          <UIcon name="i-lucide-heart" class="mx-auto size-10 text-dimmed" />
          <h2 class="mt-3 text-lg font-semibold">Your wishlist is empty</h2>
          <p class="mx-auto mt-1 max-w-sm text-sm text-muted">Add the first thing you want, and set the most you are willing to pay.</p>
        </div>

        <template v-else>
        <article v-for="e in entries" :key="e.item.id" class="rounded-xl border border-default bg-default">
          <div class="flex items-start justify-between gap-3 p-4 sm:p-5">
            <div class="min-w-0 space-y-1">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="break-words text-base font-semibold text-highlighted">{{ e.item.title }}</h2>
                <UBadge :color="STATUS_CHIP[e.item.status].color" :icon="STATUS_CHIP[e.item.status].icon" variant="subtle">
                  {{ STATUS_CHIP[e.item.status].label }}
                </UBadge>
              </div>
              <p class="flex items-center gap-1.5 text-sm text-muted">
                <UIcon name="i-lucide-search" class="size-3.5 shrink-0" />
                <span class="break-words">{{ e.item.query }}</span>
              </p>
              <p v-if="e.item.specs" class="break-words text-sm text-default">{{ e.item.specs }}</p>
            </div>
            <UButton
              :color="confirmingId === e.item.id ? 'error' : 'neutral'"
              :variant="confirmingId === e.item.id ? 'solid' : 'ghost'"
              size="sm"
              icon="i-lucide-trash-2"
              :loading="deletingId === e.item.id"
              :aria-label="confirmingId === e.item.id ? 'Confirm delete' : 'Delete'"
              class="shrink-0"
              @click="remove(e.item.id)"
            >
              <span v-if="confirmingId === e.item.id">Confirm delete</span>
            </UButton>
          </div>

          <div class="flex flex-wrap items-center gap-2 px-4 pb-4 text-sm sm:px-5">
            <UBadge color="neutral" variant="outline" icon="i-lucide-hand-coins">
              Max {{ formatMoney(e.item.maxPrice, e.item.currency) }}
            </UBadge>
            <UBadge v-if="e.item.targetPrice != null" color="neutral" variant="outline" icon="i-lucide-target">
              Target {{ formatMoney(e.item.targetPrice, e.item.currency) }}
            </UBadge>
            <UBadge color="neutral" variant="outline" icon="i-lucide-sparkles">{{ CONDITION_LABEL[e.item.minCondition] }} or better</UBadge>
            <UBadge v-for="d in e.item.dealbreakers" :key="d" color="error" variant="subtle" icon="i-lucide-ban">{{ d }}</UBadge>
          </div>

          <div class="border-t border-default p-4 sm:px-5">
            <MandateCard :mandate="e.mandate" />
          </div>
        </article>
        </template>
      </section>

      <!-- create form -->
      <section class="rounded-xl border border-default bg-default lg:sticky lg:top-20">
        <div class="border-b border-default px-4 py-3 sm:px-5">
          <h2 class="flex items-center gap-2 text-sm font-semibold text-highlighted">
            <UIcon name="i-lucide-plus" class="size-4" />
            Add to wishlist
          </h2>
        </div>
        <form class="space-y-4 p-4 sm:p-5" @submit.prevent="submit">
          <UFormField label="What do you want?" required>
            <UInput v-model="form.title" placeholder="Sonaro WH-700 headphones" class="w-full" />
          </UFormField>
          <UFormField label="Search query" description="Plain words a seller or shop would use." required>
            <UInput v-model="form.query" placeholder="Sonaro WH-700 wireless headphones" class="w-full" />
          </UFormField>
          <UFormField label="Must-haves" description="Optional. Colour, size, features.">
            <UTextarea v-model="form.specs" :rows="2" placeholder="Over-ear, noise cancelling, black" class="w-full" />
          </UFormField>
          <div class="grid grid-cols-2 gap-3">
            <UFormField label="Max price (USD)" required>
              <UInputNumber v-model="form.maxPrice" :min="0" placeholder="300" class="w-full" />
            </UFormField>
            <UFormField label="Target price" :error="targetError">
              <UInputNumber v-model="form.targetPrice" :min="0" placeholder="Optional" class="w-full" />
            </UFormField>
          </div>
          <UFormField label="Minimum condition">
            <USelect v-model="form.minCondition" :items="CONDITION_ITEMS" class="w-full" />
          </UFormField>
          <UFormField label="Dealbreakers" description="Comma-separated, e.g. refurbished, on-ear">
            <UInput v-model="form.dealbreakers" placeholder="refurbished, on-ear" class="w-full" />
          </UFormField>
          <UFormField label="Mandate valid for (days)" description="After this the agent can no longer spend on this item.">
            <UInputNumber v-model="form.days" :min="1" :max="90" class="w-full" />
          </UFormField>
          <UButton type="submit" block size="lg" icon="i-lucide-plus" :loading="submitting" :disabled="!canSubmit">
            Add to wishlist
          </UButton>
          <p class="flex items-start gap-2 text-xs text-muted">
            <UIcon name="i-lucide-shield-check" class="mt-0.5 size-3.5 shrink-0 text-success" />
            The max price becomes a hard spending mandate. You approve every payment in PayPal.
          </p>
        </form>
      </section>
    </div>
  </UContainer>
</template>
