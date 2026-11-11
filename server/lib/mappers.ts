/**
 * DB rows are snake_case, TS types are camelCase.
 * SHALLOW on purpose: only top-level column names are converted. jsonb columns (verdict, risk, guardrail,
 * payload, scripted_messages) are stored exactly as the camelCase TS objects and are left untouched.
 * For joined rows (e.g. select('*, listing:listings(*)')) call toCamel on the nested row yourself.
 */
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

export function toCamel<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) out[camel(k)] = numericToNumber(k, v)
  return out as T
}

export function toSnake(obj: object): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[snake(k)] = v
  return out
}

export const toCamelList = <T>(rows: Record<string, unknown>[] | null): T[] => (rows ?? []).map((r) => toCamel<T>(r))

/** Postgres numeric columns can arrive as strings ("365.00"). Convert the known money columns to numbers. */
const MONEY_COLUMNS = new Set(['price', 'max_price', 'target_price', 'max_amount', 'best_price', 'agreed_price', 'amount', 'floor_price', 'rating'])
function numericToNumber(column: string, v: unknown): unknown {
  return MONEY_COLUMNS.has(column) && typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : v
}
