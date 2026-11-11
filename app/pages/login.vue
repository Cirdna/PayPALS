<script setup lang="ts">
// Owner: C ("pages"). Working email/password login with a one-click demo account.
const supabase = useSupabaseClient()
const user = useSupabaseUser()
const config = useRuntimeConfig()

const email = ref('')
const password = ref('')
const error = ref('')
const loading = ref(false)

watchEffect(() => {
  if (user.value) navigateTo('/deals')
})

async function signIn(e = email.value, p = password.value) {
  loading.value = true
  error.value = ''
  const res = await supabase.auth.signInWithPassword({ email: e, password: p })
  loading.value = false
  if (res.error) error.value = res.error.message
}
</script>

<template>
  <UContainer class="py-16 max-w-md space-y-4">
    <h1 class="text-2xl font-semibold">Sign in</h1>
    <UButton v-if="config.public.demoEmail" block size="lg" :loading="loading" @click="signIn(config.public.demoEmail, config.public.demoPassword)">
      Use the demo account
    </UButton>
    <form class="space-y-3" @submit.prevent="signIn()">
      <UInput v-model="email" type="email" placeholder="Email" class="w-full" />
      <UInput v-model="password" type="password" placeholder="Password" class="w-full" />
      <UButton type="submit" block variant="outline" :loading="loading">Sign in</UButton>
    </form>
    <p v-if="error" class="text-error text-sm">{{ error }}</p>
  </UContainer>
</template>
