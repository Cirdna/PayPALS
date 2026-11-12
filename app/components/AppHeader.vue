<script setup lang="ts">
// Owner: C ("pages"). Top bar: brand, navigation (signed in only), account.
const user = useSupabaseUser()
const supabase = useSupabaseClient()
const route = useRoute()

const links = [
  { label: 'Deals', to: '/deals', icon: 'i-lucide-tags' },
  { label: 'Wishlist', to: '/wishlist', icon: 'i-lucide-heart' },
  { label: 'Settings', to: '/settings', icon: 'i-lucide-settings' },
]
const isActive = (to: string) => route.path === to || route.path.startsWith(`${to}/`)

async function signOut() {
  await supabase.auth.signOut()
  await navigateTo('/')
}
</script>

<template>
  <header class="sticky top-0 z-20 border-b border-default bg-default/80 backdrop-blur">
    <UContainer class="flex h-14 max-w-[1600px] items-center gap-2 sm:gap-4">
      <NuxtLink to="/" class="flex shrink-0 items-center gap-2 font-semibold tracking-tight text-highlighted">
        <span class="flex size-7 items-center justify-center rounded-lg bg-primary/15 text-base">🐕</span>
        <span>DealHound</span>
      </NuxtLink>

      <nav v-if="user" class="flex items-center gap-1">
        <UButton
          v-for="l in links"
          :key="l.to"
          :to="l.to"
          :icon="l.icon"
          :aria-label="l.label"
          size="sm"
          color="neutral"
          :variant="isActive(l.to) ? 'subtle' : 'ghost'"
        >
          <span class="hidden sm:inline">{{ l.label }}</span>
        </UButton>
      </nav>

      <div class="ml-auto flex items-center gap-2">
        <template v-if="user">
          <span class="hidden max-w-48 truncate text-sm text-muted md:inline">{{ user.email }}</span>
          <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-log-out" @click="signOut">
            <span class="hidden sm:inline">Sign out</span>
          </UButton>
        </template>
        <UButton v-else-if="route.path !== '/login'" to="/login" size="sm">Sign in</UButton>
      </div>
    </UContainer>
  </header>
</template>
