<script setup lang="ts">
// Owner: C ("grid"). AG Grid 36 deals board.
// `.client.vue` = rendered in the browser only (AG Grid needs the DOM).
import { defineComponent, h, type PropType } from 'vue'
import { AgGridVue } from 'ag-grid-vue3'
import {
  AllCommunityModule,
  ModuleRegistry,
  themeQuartz,
  type CellClassParams,
  type ColDef,
  type GetRowIdParams,
  type ICellRendererParams,
  type RowClassParams,
  type ValueFormatterParams,
} from 'ag-grid-community'
import type { DealRow } from '#shared/types'
import { formatMoney } from '#shared/utils/money'
import RiskBadge from './RiskBadge.vue'
import StatusChip from './StatusChip.vue'

ModuleRegistry.registerModules([AllCommunityModule])

withDefaults(defineProps<{ rows: DealRow[]; quickFilterText?: string }>(), { quickFilterText: '' })
const emit = defineEmits<{ open: [matchId: string] }>()

// Cell renderers (Vue components receive the AG Grid params as `params`).
const RiskBadgeCell = defineComponent({
  props: { params: { type: Object as PropType<ICellRendererParams<DealRow>>, required: true } },
  setup: (p) => () => h(RiskBadge, { level: p.params.data?.riskLevel ?? null, score: p.params.data?.riskScore ?? null }),
})
const StatusChipCell = defineComponent({
  props: { params: { type: Object as PropType<ICellRendererParams<DealRow>>, required: true } },
  setup: (p) => () => (p.params.data ? h(StatusChip, { status: p.params.data.status }) : null),
})

const dash = '—'
const money = (p: ValueFormatterParams<DealRow, number>) => (p.value == null ? dash : formatMoney(p.value))
const signedMoney = (p: ValueFormatterParams<DealRow, number>) => {
  if (p.value == null) return dash
  if (p.value === 0) return formatMoney(0)
  return `${p.value > 0 ? '+' : '−'}${formatMoney(Math.abs(p.value))}`
}
const signClass = (p: CellClassParams<DealRow, number>) => {
  const classes = ['ag-right-aligned-cell']
  if (typeof p.value === 'number') {
    if (p.value > 0) classes.push('deal-positive')
    else if (p.value < 0) classes.push('deal-negative')
  }
  return classes
}

const columnDefs: ColDef<DealRow>[] = [
  { field: 'wishlistTitle', headerName: 'Wishlist', pinned: 'left', minWidth: 170, cellClass: 'deal-strong' },
  { field: 'listingTitle', headerName: 'Listing', flex: 2, minWidth: 220, tooltipField: 'listingTitle' },
  {
    field: 'source',
    headerName: 'Source',
    width: 130,
    valueFormatter: (p: ValueFormatterParams<DealRow, DealRow['source']>) => (p.value ? SOURCE_LABEL[p.value] : dash),
  },
  { field: 'sellerOrRetailer', headerName: 'Seller / retailer', minWidth: 150 },
  {
    field: 'condition',
    headerName: 'Condition',
    width: 120,
    valueFormatter: (p: ValueFormatterParams<DealRow, DealRow['condition']>) => (p.value ? CONDITION_LABEL[p.value] : dash),
  },
  {
    field: 'listPrice',
    headerName: 'List price',
    valueFormatter: money,
    width: 120,
    cellClass: 'ag-right-aligned-cell',
    headerClass: 'ag-right-aligned-header',
  },
  {
    field: 'bestPrice',
    headerName: 'Best price',
    valueFormatter: money,
    width: 120,
    cellClass: ['ag-right-aligned-cell', 'deal-strong'],
    headerClass: 'ag-right-aligned-header',
  },
  {
    field: 'savings',
    headerName: 'Savings',
    valueFormatter: signedMoney,
    sort: 'desc',
    width: 115,
    cellClass: signClass,
    headerClass: 'ag-right-aligned-header',
  },
  {
    field: 'savingsVsMax',
    headerName: 'vs. limit',
    headerTooltip: 'Your maximum price minus the best price (negative = over your limit)',
    valueFormatter: signedMoney,
    width: 115,
    cellClass: signClass,
    headerClass: 'ag-right-aligned-header',
  },
  {
    field: 'riskScore',
    headerName: 'Risk',
    width: 160,
    cellRenderer: RiskBadgeCell,
    cellClass: 'deal-cell-center',
    // Filter/sort on the level text, display the badge.
    filterValueGetter: (p) => p.data?.riskLevel ?? '',
  },
  {
    field: 'status',
    headerName: 'Status',
    width: 215,
    cellRenderer: StatusChipCell,
    cellClass: 'deal-cell-center',
    filterValueGetter: (p) => (p.data ? STATUS_LABEL[p.data.status].label : ''),
  },
  {
    field: 'updatedAt',
    headerName: 'Updated',
    width: 130,
    valueFormatter: (p: ValueFormatterParams<DealRow, string>) => relativeTime(p.value),
    tooltipValueGetter: (p) => (p.value ? new Date(p.value as string).toLocaleString() : ''),
  },
]

const defaultColDef: ColDef<DealRow> = { sortable: true, resizable: true, filter: true }

const rowClassRules = {
  'deal-flagged': (p: RowClassParams<DealRow>) => p.data?.status === 'flagged',
  'deal-muted': (p: RowClassParams<DealRow>) => !!p.data && ['over_budget', 'skipped', 'no_deal'].includes(p.data.status),
}

const getRowId = (p: GetRowIdParams<DealRow>) => p.data.matchId
</script>

<template>
  <div class="deals-grid">
    <AgGridVue
      style="width: 100%"
      dom-layout="autoHeight"
      :theme="themeQuartz"
      :row-data="rows"
      :column-defs="columnDefs"
      :default-col-def="defaultColDef"
      :row-class-rules="rowClassRules"
      :quick-filter-text="quickFilterText"
      :get-row-id="getRowId"
      :row-height="52"
      :header-height="42"
      :tooltip-show-delay="400"
      :suppress-cell-focus="true"
      :animate-rows="true"
      @row-clicked="(e: { data?: DealRow }) => e.data && emit('open', e.data.matchId)"
    />
  </div>
</template>

<style>
/* Not scoped: AG Grid renders rows outside this component's scope. */
.deals-grid .ag-row {
  cursor: pointer;
}
.deals-grid .ag-row.deal-flagged {
  background-color: rgb(239 68 68 / 0.1);
}
.deals-grid .ag-row.deal-flagged:hover {
  background-color: rgb(239 68 68 / 0.16);
}
.deals-grid .ag-row.deal-muted {
  opacity: 0.6;
}
.deals-grid .ag-row.deal-muted:hover {
  opacity: 0.85;
}
.deals-grid .deal-strong {
  font-weight: 600;
}
.deals-grid .deal-positive {
  color: rgb(22 163 74);
  font-weight: 600;
}
.deals-grid .deal-negative {
  color: rgb(220 38 38);
}
.deals-grid .deal-cell-center {
  display: flex;
  align-items: center;
}
</style>
