<script setup lang="ts">
// Owner: C ("grid"). Placeholder: loads GET /api/deals once it exists; shows an empty grid until then.
import type { DealRow } from '#shared/types'

const { data: rows } = await useFetch<DealRow[]>('/api/deals', { default: () => [], server: false })
</script>

<template>
  <UContainer class="py-8 space-y-4">
    <h1 class="text-2xl font-semibold">Deals</h1>
    <DealsGrid :rows="rows ?? []" @open="(id) => navigateTo(`/deals/${id}`)" />
  </UContainer>
</template>
