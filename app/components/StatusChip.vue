<script setup lang="ts">
// Owner: C ("grid").
import type { MatchStatus } from '#shared/types'

const props = defineProps<{ status: MatchStatus }>()

const meta = computed(() => STATUS_LABEL[props.status])
</script>

<template>
  <UBadge v-if="meta" :color="meta.color" :icon="meta.icon" variant="subtle">{{ meta.label }}</UBadge>
</template>
