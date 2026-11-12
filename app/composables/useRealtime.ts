// Owner: C ("grid").
/** Calls `onChange` whenever a row of `table` that the signed-in user may read changes. Cleans up on unmount. */
export function useRealtime(
  table: 'matches' | 'negotiation_messages' | 'agent_events',
  onChange: () => void,
  filter?: string,
) {
  const client = useSupabaseClient()
  let channel: ReturnType<typeof client.channel> | null = null
  onMounted(() => {
    channel = client
      .channel(`rt-${table}-${filter ?? 'all'}-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table, ...(filter ? { filter } : {}) }, () => onChange())
      .subscribe()
  })
  onUnmounted(() => {
    if (channel) client.removeChannel(channel)
  })
}
