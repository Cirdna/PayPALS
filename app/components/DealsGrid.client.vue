<script setup lang="ts">
// Owner: C ("grid"). Minimal WORKING AG Grid 36 setup — extend it, keep the module registration.
// `.client.vue` = rendered in the browser only (AG Grid needs the DOM).
import { AgGridVue } from 'ag-grid-vue3'
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from 'ag-grid-community'
import type { DealRow } from '#shared/types'
import { formatMoney } from '#shared/utils/money'

ModuleRegistry.registerModules([AllCommunityModule])

defineProps<{ rows: DealRow[] }>()
const emit = defineEmits<{ open: [matchId: string] }>()

const money = (p: { value: number | null }) => (p.value == null ? '' : formatMoney(p.value))
const columnDefs: ColDef<DealRow>[] = [
  { field: 'wishlistTitle', headerName: 'Wishlist', pinned: 'left', filter: true },
  { field: 'listingTitle', headerName: 'Listing', flex: 2, filter: true },
  { field: 'source', filter: true, width: 130 },
  { field: 'sellerOrRetailer', headerName: 'Seller / retailer', filter: true },
  { field: 'listPrice', headerName: 'List price', valueFormatter: money, width: 120 },
  { field: 'bestPrice', headerName: 'Best price', valueFormatter: money, width: 120 },
  { field: 'savings', valueFormatter: money, sort: 'desc', width: 110 },
  { field: 'riskLevel', headerName: 'Risk', filter: true, width: 110 },
  { field: 'status', filter: true, width: 150 },
]
</script>

<template>
  <AgGridVue
    style="width: 100%; height: 520px"
    :theme="themeQuartz"
    :row-data="rows"
    :column-defs="columnDefs"
    :get-row-id="(p: { data: DealRow }) => p.data.matchId"
    @row-clicked="(e: { data?: DealRow }) => e.data && emit('open', e.data.matchId)"
  />
</template>
