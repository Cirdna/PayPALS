<script setup lang="ts">
// Auth callback page required by @nuxtjs/supabase (redirectOptions.callback).
const user = useSupabaseUser()
watchEffect(() => {
  if (user.value) navigateTo('/deals')
})
</script>

<template>
  <UContainer class="py-16">Signing you in…</UContainer>
</template>
