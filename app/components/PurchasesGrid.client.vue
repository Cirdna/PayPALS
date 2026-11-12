<script setup lang="ts">
// Owner: C ("grid"). AG Grid purchase history. Clicking a row opens the deal page (negotiation transcript + risk evidence).
import { AgGridVue } from 'ag-grid-vue3'
import {
  AllCommunityModule,
  ModuleRegistry,
  type ColDef,
  type GetRowIdParams,
  type ValueFormatterParams,
  type ValueGetterParams,
} from 'ag-grid-community'
import { formatMoney, roundMoney } from '#shared/utils/money'
import type { Purchase } from '~/utils/purchases'

ModuleRegistry.registerModules([AllCommunityModule])

const theme = useGridTheme()

withDefaults(defineProps<{ rows: Purchase[]; quickFilterText?: string }>(), { quickFilterText: '' })
const emit = defineEmits<{ open: [matchId: string] }>()

const dash = '—'
const money = (p: ValueFormatterParams<Purchase, number>) => (p.value == null ? dash : formatMoney(p.value))
const dateTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

// Pinned columns only make sense when there is room: on a phone they would fill the whole grid.
const roomy = ref(true)
onMounted(() => {
  const mq = window.matchMedia('(min-width: 768px)')
  roomy.value = mq.matches
  mq.addEventListener('change', (e) => {
    roomy.value = e.matches
  })
})

const columnDefs = computed<ColDef<Purchase>[]>(() => [
  {
    colId: 'purchasedAt',
    headerName: 'Purchased',
    valueGetter: (p: ValueGetterParams<Purchase>) => p.data?.order.updatedAt ?? null,
    valueFormatter: (p: ValueFormatterParams<Purchase, string>) => (p.value ? dateTime.format(new Date(p.value)) : dash),
    sort: 'desc',
    width: 170,
    hide: !roomy.value,
  },
  { field: 'deal.listingTitle', headerName: 'Item', flex: 1, minWidth: 190, tooltipField: 'deal.listingTitle', cellClass: 'purchase-strong' },
  { field: 'deal.wishlistTitle', headerName: 'Wishlist', width: 170, hide: !roomy.value },
  { field: 'deal.sellerOrRetailer', headerName: 'Seller / retailer', minWidth: 140, hide: !roomy.value },
  {
    field: 'deal.condition',
    headerName: 'Condition',
    width: 115,
    hide: !roomy.value,
    valueFormatter: (p: ValueFormatterParams<Purchase, Purchase['deal']['condition']>) => (p.value ? CONDITION_LABEL[p.value] : dash),
  },
  {
    field: 'deal.listPrice',
    headerName: 'List price',
    valueFormatter: money,
    width: 110,
    hide: !roomy.value,
    suppressHeaderFilterButton: true,
    cellClass: 'ag-right-aligned-cell',
    headerClass: 'ag-right-aligned-header',
  },
  {
    field: 'order.amount',
    headerName: 'Paid',
    valueFormatter: money,
    width: 110,
    suppressHeaderFilterButton: true,
    cellClass: ['ag-right-aligned-cell', 'purchase-strong'],
    headerClass: 'ag-right-aligned-header',
  },
  {
    colId: 'saved',
    headerName: 'Saved',
    valueGetter: (p: ValueGetterParams<Purchase>) => (p.data ? Math.max(0, roundMoney(p.data.deal.listPrice - p.data.order.amount)) : null),
    valueFormatter: money,
    width: 110,
    suppressHeaderFilterButton: true,
    cellClass: (p) => ['ag-right-aligned-cell', ...(typeof p.value === 'number' && p.value > 0 ? ['purchase-positive'] : [])],
    headerClass: 'ag-right-aligned-header',
  },
  {
    colId: 'open',
    headerName: '',
    width: 150,
    pinned: roomy.value ? 'right' : null,
    sortable: false,
    filter: false,
    resizable: false,
    valueGetter: () => 'View negotiation →',
    cellClass: 'purchase-link',
  },
])

const defaultColDef: ColDef<Purchase> = { sortable: true, resizable: true, filter: true }

const getRowId = (p: GetRowIdParams<Purchase>) => p.data.order.id
</script>

<template>
  <div class="purchases-grid">
    <AgGridVue
      style="width: 100%"
      dom-layout="autoHeight"
      :theme="theme"
      :row-data="rows"
      :column-defs="columnDefs"
      :default-col-def="defaultColDef"
      :quick-filter-text="quickFilterText"
      :get-row-id="getRowId"
      :row-height="52"
      :header-height="42"
      :tooltip-show-delay="400"
      :suppress-cell-focus="true"
      :animate-rows="true"
      @row-clicked="(e: { data?: Purchase }) => e.data && emit('open', e.data.deal.matchId)"
    />
  </div>
</template>

<style>
/* Not scoped: AG Grid renders rows outside this component's scope. */
.purchases-grid .ag-row {
  cursor: pointer;
}
.purchases-grid .purchase-strong {
  font-weight: 600;
}
.purchases-grid .purchase-positive {
  color: rgb(22 163 74);
  font-weight: 600;
}
.purchases-grid .purchase-link {
  color: var(--ui-primary);
  font-weight: 500;
}
</style>
