<script setup lang="ts">
// Owner: C ("pages"). Telegram link and demo reset.
useHead({ title: 'Settings · DealHound' })

interface Me {
  id: string
  email: string | null
  displayName: string
  telegramLinked: boolean
  telegramStartUrl: string | null
  isDemo: boolean
}

const { data: me, refresh, status } = useFetch<Me>('/api/me', { server: false })
const loading = computed(() => !me.value && status.value !== 'error')
const refreshing = ref(false)

async function refreshStatus() {
  refreshing.value = true
  await refresh()
  refreshing.value = false
  useToast().add({
    title: me.value?.telegramLinked ? 'Telegram is linked' : 'Telegram is not linked yet',
    color: me.value?.telegramLinked ? 'success' : 'neutral',
  })
}

// Demo reset: two-step confirm (no modal).
const confirmingReset = ref(false)
const resetting = ref(false)
let confirmTimer: ReturnType<typeof setTimeout> | null = null
onUnmounted(() => {
  if (confirmTimer) clearTimeout(confirmTimer)
})

async function resetDemo() {
  if (!confirmingReset.value) {
    confirmingReset.value = true
    confirmTimer = setTimeout(() => (confirmingReset.value = false), 4000)
    return
  }
  confirmingReset.value = false
  resetting.value = true
  const ok = await apiOk('/api/demo/reset', { method: 'POST' })
  resetting.value = false
  if (ok) {
    useToast().add({ title: 'Demo data reset', description: 'Matches cleared and wishlist items are active again.', color: 'success' })
    await navigateTo('/deals')
  }
}
</script>

<template>
  <UContainer class="max-w-2xl space-y-6 py-8">
    <div>
      <h1 class="text-2xl font-semibold tracking-tight">Settings</h1>
      <p class="mt-1 text-sm text-muted">Where your agent reaches you, and your account.</p>
    </div>

    <template v-if="loading">
      <USkeleton class="h-36 w-full rounded-xl" />
      <USkeleton class="h-28 w-full rounded-xl" />
    </template>

    <UAlert
      v-else-if="!me"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      title="Could not load your settings"
      :actions="[{ label: 'Retry', color: 'error', variant: 'outline', onClick: () => refresh() }]"
    />

    <template v-else>
      <section class="rounded-xl border border-default bg-default p-4 sm:p-5">
        <div class="flex items-start gap-3">
          <div class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-info/10">
            <UIcon name="i-lucide-send" class="size-5 text-info" />
          </div>
          <div class="min-w-0 flex-1 space-y-3">
            <div>
              <h2 class="font-semibold text-highlighted">Telegram alerts</h2>
              <p class="text-sm text-muted">Get a message with Pay and Skip buttons the moment your agent lands a deal.</p>
            </div>

            <div v-if="me.telegramLinked" class="flex items-center gap-2 text-sm font-medium text-success">
              <UIcon name="i-lucide-circle-check" class="size-4" />
              Linked. You will be notified in Telegram.
            </div>
            <template v-else-if="me.telegramStartUrl">
              <div class="flex flex-wrap gap-2">
                <UButton :to="me.telegramStartUrl" target="_blank" icon="i-lucide-link">Link Telegram</UButton>
                <UButton color="neutral" variant="outline" icon="i-lucide-refresh-cw" :loading="refreshing" @click="refreshStatus">
                  Refresh status
                </UButton>
              </div>
              <p class="text-xs text-muted">Open the link, press Start in Telegram, then come back and refresh.</p>
            </template>
            <p v-else class="text-sm text-muted">Telegram is not configured on this deployment.</p>
          </div>
        </div>
      </section>

      <section class="rounded-xl border border-default bg-default p-4 sm:p-5">
        <h2 class="font-semibold text-highlighted">Account</h2>
        <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt class="text-muted">Name</dt>
          <dd class="break-words">{{ me.displayName }}</dd>
          <dt class="text-muted">Email</dt>
          <dd class="break-words">{{ me.email }}</dd>
        </dl>
      </section>

      <section v-if="me.isDemo" class="rounded-xl border border-warning/40 bg-warning/10 p-4 sm:p-5">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="min-w-0">
            <h2 class="font-semibold text-highlighted">Demo account</h2>
            <p class="text-sm text-muted">Clear all matches and negotiations and start the demo again from a clean board.</p>
          </div>
          <UButton
            :color="confirmingReset ? 'error' : 'warning'"
            :variant="confirmingReset ? 'solid' : 'outline'"
            icon="i-lucide-rotate-ccw"
            :loading="resetting"
            @click="resetDemo"
          >
            {{ confirmingReset ? 'Click again to confirm' : 'Reset demo data' }}
          </UButton>
        </div>
      </section>
    </template>
  </UContainer>
</template>
