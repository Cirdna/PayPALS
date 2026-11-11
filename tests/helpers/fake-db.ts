import { randomUUID } from 'node:crypto'

/**
 * In-memory stand-in for the Supabase client returned by db(). Use in unit tests:
 *
 *   const fake = createFakeDb({ matches: [{ id: 'm1', status: 'agreed', ... }] })
 *   setDbForTests(fake)            // from ~~/server/lib/db
 *   ...run the code under test...
 *   expect(fake.rows('matches')[0].status).toBe('notified')
 *   afterEach(() => setDbForTests(null))
 *
 * SUPPORTED (write production code inside this subset so it stays testable):
 *   from(t).select(cols?)  .insert(row | rows)  .update(patch)  .upsert(row | rows, { onConflict: 'a,b' })  .delete()
 *   filters: .eq .neq .in .is(col, null) .not(col, 'is', null) .lt .lte .gt .gte
 *   modifiers: .order(col, { ascending?, nullsFirst? })  .limit(n)  .select()  .single()  .maybeSingle()
 *   rpc('claim_negotiation', { p_id, p_lock_seconds })   rpc('claim_deal_notification', { p_match_id })
 * NOT SUPPORTED on purpose: embedded joins such as select('*, listing:listings(*)'), .or(), .textSearch(), .range().
 *   → load related rows with separate simple queries.
 * Like the real client, writes return `data: null` unless you chain `.select()` (e.g. `.insert(row).select().single()`).
 * Rows are snake_case, exactly like the real database. `select('a, b')` column lists are accepted but all columns are returned.
 */

type Row = Record<string, any>
type Result<T> = { data: T; error: null } | { data: null; error: { message: string; code?: string } }
type Filter = (row: Row) => boolean

/** Unique constraints of the real schema (supabase/migrations/0001_init.sql). */
const UNIQUES: Record<string, string[][]> = {
  matches: [['wishlist_item_id', 'listing_id']],
  negotiations: [['match_id']],
  listings: [['source', 'external_id']],
  sellers: [['slug']],
  orders: [['paypal_order_id']],
  mandates: [['wishlist_item_id']],
  webhook_events: [['id']],
  seller_personas: [['seller_id']],
  listing_secrets: [['listing_id']],
}
/** Tables whose primary key is not an auto-generated `id`. */
const NO_AUTO_ID = new Set(['seller_personas', 'listing_secrets', 'webhook_events', 'profiles'])
/** Column defaults of the real schema that production code relies on. */
const DEFAULTS: Record<string, Row> = {
  negotiations: { status: 'active', round: 0, max_rounds: 6, agreed_price: null, locked_until: null },
  orders: { status: 'created', approve_url: null, capture_id: null },
  matches: { verdict: null, risk: null, best_price: null, notified_at: null },
  wishlist_items: { status: 'active', last_scanned_at: null, dealbreakers: [], specs: '', currency: 'USD', target_price: null },
  mandates: { currency: 'USD', require_human_approval: true, revoked_at: null },
  listings: { currency: 'USD', description: '', negotiable: false, url: null, image_url: null, retailer: null, seller_id: null, condition: null },
  agent_events: { payload: {}, match_id: null },
  negotiation_messages: { message: '', price: null, guardrail: null },
  listing_secrets: { scripted_messages: {} },
}

export interface FakeDb {
  from(table: string): Query
  rpc(name: string, args?: Row): Promise<Result<Row[]>>
  /** Current rows of a table (live array of copies — for assertions). */
  rows(table: string): Row[]
  /** Fake clock used for created_at / updated_at / locks. Advance it to expire a lock. */
  now: Date
  advance(ms: number): void
  /** Number of queries executed per table — handy for "no LLM / no write happened" assertions. */
  calls: { table: string; op: string }[]
}

export function createFakeDb(seed: Record<string, Row[]> = {}): FakeDb {
  const tables = new Map<string, Row[]>()
  for (const [t, rows] of Object.entries(seed)) tables.set(t, rows.map((r) => ({ ...r })))
  const table = (t: string) => {
    if (!tables.has(t)) tables.set(t, [])
    return tables.get(t)!
  }

  const fake: FakeDb = {
    now: new Date('2026-11-12T00:00:00.000Z'),
    calls: [],
    advance(ms) { fake.now = new Date(fake.now.getTime() + ms) },
    rows: (t) => table(t).map((r) => ({ ...r })),
    from: (t) => new Query(t),
    async rpc(name, args = {}) {
      fake.calls.push({ table: `rpc:${name}`, op: 'rpc' })
      if (name === 'claim_negotiation') {
        const row = table('negotiations').find((r) => r.id === args.p_id && r.status === 'active'
          && (r.locked_until == null || new Date(r.locked_until).getTime() < fake.now.getTime()))
        if (!row) return { data: [], error: null }
        row.locked_until = new Date(fake.now.getTime() + (args.p_lock_seconds ?? 45) * 1000).toISOString()
        return { data: [{ ...row }], error: null }
      }
      if (name === 'claim_deal_notification') {
        const row = table('matches').find((r) => r.id === args.p_match_id && r.status === 'agreed')
        if (!row) return { data: [], error: null }
        row.status = 'notified'
        row.notified_at = tick()
        row.updated_at = row.notified_at
        return { data: [{ ...row }], error: null }
      }
      return { data: null, error: { message: `fake-db: unknown rpc ${name}` } }
    },
  }

  /** Every write gets a strictly increasing timestamp so ordering by created_at is deterministic. */
  function tick(): string {
    fake.now = new Date(fake.now.getTime() + 1)
    return fake.now.toISOString()
  }

  function violatesUnique(t: string, candidate: Row, ignore?: Row): boolean {
    return (UNIQUES[t] ?? []).some((cols) => table(t).some((r) => r !== ignore && cols.every((c) => r[c] != null && r[c] === candidate[c])))
  }

  class Query implements PromiseLike<Result<any>> {
    private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select'
    private filters: Filter[] = []
    private payload: Row[] = []
    private patch: Row = {}
    private conflictCols: string[] = []
    private orderBy: { col: string; asc: boolean; nullsFirst: boolean }[] = []
    private max: number | null = null
    private mode: 'many' | 'single' | 'maybeSingle' = 'many'
    /** Like the real client: insert/update/upsert/delete return data only when .select() is chained. */
    private returning = false

    constructor(private readonly t: string) {}

    select(_cols?: string) { this.returning = true; return this }
    insert(rows: Row | Row[]) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this }
    update(patch: Row) { this.op = 'update'; this.patch = patch; return this }
    upsert(rows: Row | Row[], opts: { onConflict?: string } = {}) {
      this.op = 'upsert'
      this.payload = Array.isArray(rows) ? rows : [rows]
      this.conflictCols = (opts.onConflict ?? 'id').split(',').map((s) => s.trim())
      return this
    }
    delete() { this.op = 'delete'; return this }

    eq(col: string, v: unknown) { this.filters.push((r) => r[col] === v); return this }
    neq(col: string, v: unknown) { this.filters.push((r) => r[col] !== v); return this }
    in(col: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[col])); return this }
    is(col: string, v: null) { this.filters.push((r) => (r[col] ?? null) === v); return this }
    not(col: string, operator: 'is', v: null) {
      if (operator !== 'is') throw new Error('fake-db: only .not(col, "is", null) is supported')
      this.filters.push((r) => (r[col] ?? null) !== v)
      return this
    }
    lt(col: string, v: any) { this.filters.push((r) => r[col] != null && r[col] < v); return this }
    lte(col: string, v: any) { this.filters.push((r) => r[col] != null && r[col] <= v); return this }
    gt(col: string, v: any) { this.filters.push((r) => r[col] != null && r[col] > v); return this }
    gte(col: string, v: any) { this.filters.push((r) => r[col] != null && r[col] >= v); return this }
    order(col: string, opts: { ascending?: boolean; nullsFirst?: boolean } = {}) {
      const asc = opts.ascending ?? true
      this.orderBy.push({ col, asc, nullsFirst: opts.nullsFirst ?? !asc })
      return this
    }
    limit(n: number) { this.max = n; return this }
    single() { this.mode = 'single'; return this }
    maybeSingle() { this.mode = 'maybeSingle'; return this }

    then<A = Result<any>, B = never>(ok?: ((v: Result<any>) => A | PromiseLike<A>) | null, fail?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
      return Promise.resolve().then(() => this.run()).then(ok, fail)
    }

    private matching(): Row[] { return table(this.t).filter((r) => this.filters.every((f) => f(r))) }

    private run(): Result<any> {
      fake.calls.push({ table: this.t, op: this.op })
      let out: Row[]
      if (this.op === 'select') {
        out = this.matching()
      } else if (this.op === 'insert') {
        const created: Row[] = []
        for (const input of this.payload) {
          const ts = tick()
          const row: Row = { ...(DEFAULTS[this.t] ?? {}), created_at: ts, updated_at: ts, ...input }
          if (!NO_AUTO_ID.has(this.t) && row.id == null) row.id = randomUUID()
          if (violatesUnique(this.t, row)) return { data: null, error: { message: `duplicate key value violates unique constraint on ${this.t}`, code: '23505' } }
          table(this.t).push(row)
          created.push(row)
        }
        out = created
      } else if (this.op === 'upsert') {
        out = []
        for (const input of this.payload) {
          const existing = table(this.t).find((r) => this.conflictCols.every((c) => r[c] === input[c]))
          if (existing) {
            Object.assign(existing, input, { updated_at: tick() })
            out.push(existing)
          } else {
            const ts = tick()
            const row: Row = { ...(DEFAULTS[this.t] ?? {}), created_at: ts, updated_at: ts, ...input }
            if (!NO_AUTO_ID.has(this.t) && row.id == null) row.id = randomUUID()
            table(this.t).push(row)
            out.push(row)
          }
        }
      } else if (this.op === 'update') {
        out = this.matching()
        for (const row of out) {
          const next = { ...row, ...this.patch }
          if (violatesUnique(this.t, next, row)) return { data: null, error: { message: `duplicate key value violates unique constraint on ${this.t}`, code: '23505' } }
          Object.assign(row, this.patch, { updated_at: tick() })
        }
      } else {
        out = this.matching()
        tables.set(this.t, table(this.t).filter((r) => !out.includes(r)))
      }

      for (const o of [...this.orderBy].reverse()) {
        out = [...out].sort((a, b) => {
          const av = a[o.col] ?? null
          const bv = b[o.col] ?? null
          if (av === null && bv === null) return 0
          if (av === null) return o.nullsFirst ? -1 : 1
          if (bv === null) return o.nullsFirst ? 1 : -1
          return (av < bv ? -1 : av > bv ? 1 : 0) * (o.asc ? 1 : -1)
        })
      }
      if (this.max != null) out = out.slice(0, this.max)
      if (!this.returning) return { data: null, error: null }
      const copies = out.map((r) => ({ ...r }))

      if (this.mode === 'single') {
        return copies.length === 1 ? { data: copies[0], error: null } : { data: null, error: { message: `fake-db: expected exactly one row from ${this.t}, got ${copies.length}`, code: 'PGRST116' } }
      }
      if (this.mode === 'maybeSingle') {
        return copies.length <= 1 ? { data: copies[0] ?? null, error: null } : { data: null, error: { message: `fake-db: expected at most one row from ${this.t}, got ${copies.length}`, code: 'PGRST116' } }
      }
      return { data: copies, error: null }
    }
  }

  return fake
}
