<script setup lang="ts">
// Owner: C ("grid"). Live agent activity log (newest first).
import type { AgentEvent } from '#shared/types'

const { data, refresh, status } = useFetch<AgentEvent[]>('/api/events?limit=30', { server: false, default: () => [] })
const events = computed<AgentEvent[]>(() => data.value ?? [])
// Latches after the first response so a Realtime refresh does not swap the feed for the skeleton (flashing).
const loaded = ref(false)
watch(status, (s) => {
  if (s === 'success' || s === 'error') loaded.value = true
}, { immediate: true })

const debouncedRefresh = useDebounced(() => {
  void refresh()
}, 500)
useRealtime('agent_events', debouncedRefresh)

// Tick so relative times stay fresh.
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 30_000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

const isDanger = (e: AgentEvent) => EVENT_DANGER.has(e.type)
</script>

<template>
  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <div class="flex items-center justify-between">
        <h2 class="flex items-center gap-2 font-semibold">
          <UIcon name="i-lucide-activity" class="size-4 text-muted" />
          Agent activity
        </h2>
        <span class="flex items-center gap-1.5 text-xs text-muted">
          <span class="relative flex size-2">
            <span class="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
            <span class="relative inline-flex size-2 rounded-full bg-success" />
          </span>
          Live
        </span>
      </div>
    </template>

    <div v-if="!loaded" class="space-y-3 p-4">
      <USkeleton v-for="i in 5" :key="i" class="h-8 w-full" />
    </div>

    <p v-else-if="events.length === 0" class="p-4 text-sm text-muted">
      No activity yet. Press "Scan now" and the agent will report here.
    </p>

    <ul v-else class="max-h-[32rem] divide-y divide-default overflow-y-auto">
      <li v-for="e in events" :key="e.id" class="flex items-start gap-3 px-4 py-3">
        <UIcon
          :name="EVENT_ICON[e.type] ?? 'i-lucide-dot'"
          class="mt-0.5 size-4 shrink-0"
          :class="isDanger(e) ? 'text-error' : 'text-muted'"
        />
        <div class="min-w-0 flex-1">
          <p class="text-sm leading-snug" :class="isDanger(e) ? 'font-medium text-error' : ''">{{ e.message }}</p>
          <p class="mt-0.5 text-xs text-dimmed">{{ relativeTime(e.createdAt, now) }}</p>
        </div>
      </li>
    </ul>
  </UCard>
</template>
