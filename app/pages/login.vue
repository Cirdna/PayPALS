<script setup lang="ts">
// Owner: C ("pages"). Working email/password login with a one-click demo account.
useHead({ title: 'Sign in · DealHound' })
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
  <UContainer class="max-w-md py-12 sm:py-20">
    <div class="space-y-6 rounded-2xl border border-default bg-default p-6 shadow-sm sm:p-8">
      <div class="space-y-1 text-center">
        <div class="mx-auto flex size-12 items-center justify-center rounded-xl bg-primary/15 text-2xl">🐕</div>
        <h1 class="pt-2 text-2xl font-semibold tracking-tight">Welcome to DealHound</h1>
        <p class="text-sm text-muted">Sign in to see what your agent found.</p>
      </div>

      <template v-if="config.public.demoEmail">
        <UButton
          block
          size="lg"
          icon="i-lucide-play"
          :loading="loading"
          @click="signIn(config.public.demoEmail, config.public.demoPassword)"
        >
          Use the demo account
        </UButton>
        <div class="flex items-center gap-3 text-xs text-muted">
          <span class="h-px flex-1 border-t border-default" />
          or sign in with email
          <span class="h-px flex-1 border-t border-default" />
        </div>
      </template>

      <form class="space-y-4" @submit.prevent="signIn()">
        <UFormField label="Email">
          <UInput v-model="email" type="email" autocomplete="email" placeholder="you@example.com" class="w-full" />
        </UFormField>
        <UFormField label="Password">
          <UInput v-model="password" type="password" autocomplete="current-password" placeholder="Password" class="w-full" />
        </UFormField>
        <UButton type="submit" block variant="outline" :loading="loading" :disabled="!email || !password">Sign in</UButton>
      </form>

      <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="error" />
    </div>
  </UContainer>
</template>
