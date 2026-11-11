<script setup lang="ts">
useHead({
  htmlAttrs: { lang: 'en' },
  link: [{ rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' }],
  meta: [{ name: 'description', content: 'DealHound is an AI buyer’s agent: it finds deals, screens out scams, haggles inside a spending limit enforced in code, and you approve the payment with PayPal.' }],
})
</script>

<template>
  <UApp>
    <AppHeader />
    <main>
      <NuxtPage />
    </main>
  </UApp>
</template>
