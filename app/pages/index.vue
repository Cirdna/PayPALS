<script setup lang="ts">
// Owner: C ("pages"). Placeholder landing page — replace freely.
const user = useSupabaseUser()
</script>

<template>
  <UContainer class="py-16 space-y-6">
    <h1 class="text-4xl font-bold">DealHound 🐕</h1>
    <p class="text-lg text-muted max-w-2xl">
      Your AI buyer's agent: it watches for deals, screens out scams, haggles within your limit, and you approve the
      payment with PayPal.
    </p>
    <div class="flex gap-3">
      <UButton v-if="user" to="/deals" size="lg">Open my deals</UButton>
      <UButton v-else to="/login" size="lg">Try the demo</UButton>
    </div>
  </UContainer>
</template>
