<script setup lang="ts">
// Owner: C ("pages"). Landing page.
useHead({ title: 'DealHound · your AI buyer’s agent' })
const user = useSupabaseUser()

const features = [
  {
    icon: 'i-lucide-scan-search',
    title: 'Scam check with evidence',
    text: 'Every listing is screened. If a seller asks you to pay outside the platform, the agent quotes the exact words.',
  },
  {
    icon: 'i-lucide-handshake',
    title: 'Negotiation inside a hard limit',
    text: 'It haggles for you, but a spending mandate enforced in code means it can never go over your maximum.',
  },
  {
    icon: 'i-lucide-wallet',
    title: 'You approve in PayPal',
    text: 'No money moves until you approve the exact agreed amount in PayPal. The agent cannot pay on its own.',
  },
]
</script>

<template>
  <div class="relative overflow-hidden">
    <div class="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[32rem] bg-linear-to-b from-primary/10 to-transparent" />

    <UContainer class="py-14 sm:py-20">
      <div class="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_26rem]">
        <div class="space-y-6">
          <UBadge color="primary" variant="subtle" icon="i-lucide-sparkles">AI buyer’s agent</UBadge>
          <h1 class="text-4xl font-bold tracking-tight text-highlighted sm:text-5xl">
            Your agent finds the deal,<br class="hidden sm:block" />
            haggles it down, and you just approve.
          </h1>
          <p class="max-w-xl text-lg text-muted">
            DealHound watches for what you want, screens out scams, negotiates inside a limit you set, and hands you a
            PayPal approval for the final price.
          </p>
          <div class="flex flex-wrap gap-3">
            <UButton v-if="user" to="/deals" size="xl" trailing-icon="i-lucide-arrow-right">Open my deals</UButton>
            <UButton v-else to="/login" size="xl" trailing-icon="i-lucide-arrow-right">Try the demo</UButton>
          </div>
        </div>

        <!-- illustrative example, not live data -->
        <div class="rounded-2xl border border-default bg-default p-4 shadow-lg" aria-hidden="true">
          <p class="mb-3 text-xs font-medium uppercase tracking-wide text-muted">Example deal</p>
          <p class="font-semibold text-highlighted">Sonaro WH-700 headphones</p>
          <div class="mt-1 flex items-center gap-2">
            <UBadge color="success" variant="subtle">Low risk · 10</UBadge>
            <UBadge color="success" variant="subtle" icon="i-lucide-handshake">Deal agreed</UBadge>
          </div>
          <div class="mt-4 space-y-2 text-sm">
            <div class="ml-auto w-fit max-w-[85%] rounded-2xl rounded-tr-sm border border-primary/25 bg-primary/10 px-3 py-2">
              I can do $255 today. Would that work?
            </div>
            <div class="w-fit max-w-[85%] rounded-2xl rounded-tl-sm border border-default bg-muted px-3 py-2">
              Meet me at $262 and it is yours.
            </div>
          </div>
          <div class="mt-4 flex items-end justify-between rounded-lg bg-muted px-3 py-2">
            <div>
              <p class="text-xs text-muted line-through">$279.00</p>
              <p class="text-xl font-bold text-highlighted">$262.00</p>
            </div>
            <p class="text-sm font-medium text-success">You save $17.00</p>
          </div>
        </div>
      </div>

      <div class="mt-16 grid gap-4 sm:grid-cols-3">
        <div v-for="f in features" :key="f.title" class="rounded-xl border border-default bg-default p-5">
          <div class="flex size-10 items-center justify-center rounded-lg bg-primary/10">
            <UIcon :name="f.icon" class="size-5 text-primary" />
          </div>
          <h2 class="mt-3 font-semibold text-highlighted">{{ f.title }}</h2>
          <p class="mt-1 text-sm text-muted">{{ f.text }}</p>
        </div>
      </div>
    </UContainer>
  </div>
</template>
