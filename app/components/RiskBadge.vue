<script setup lang="ts">
// Owner: C ("grid"). Renders nothing when `level` is null.
import type { RiskLevel } from '#shared/types'

const props = defineProps<{ level: RiskLevel | null; score?: number | null }>()

const meta = computed(() => (props.level ? RISK_LABEL[props.level] : null))
const text = computed(() => {
  if (!meta.value) return ''
  return props.score == null ? meta.value.label : `${meta.value.label} · ${Math.round(props.score)}`
})
</script>

<template>
  <UBadge v-if="meta" :color="meta.color" variant="subtle">{{ text }}</UBadge>
</template>
