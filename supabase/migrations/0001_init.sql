-- DealHound initial schema. Contract file: changes must be announced to all leads.
-- snake_case columns; TS types in shared/types.ts are camelCase.

create extension if not exists "pgcrypto";

-- ───────────── helpers ─────────────
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

-- ───────────── users ─────────────
create table public.profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  display_name        text,
  telegram_chat_id    bigint unique,
  telegram_link_token text unique default encode(gen_random_bytes(12), 'hex'),
  created_at          timestamptz not null default now()
);

-- auto-create profile on signup
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name) values (new.id, coalesce(new.raw_user_meta_data->>'name', new.email));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ───────────── wishlist & mandate ─────────────
create table public.wishlist_items (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  title          text not null,
  query          text not null,
  specs          text not null default '',
  max_price      numeric(10,2) not null check (max_price > 0),
  target_price   numeric(10,2) check (target_price is null or target_price > 0),
  currency       text not null default 'USD',
  min_condition  text not null default 'like_new' check (min_condition in ('new','like_new','good','fair')),
  dealbreakers   text[] not null default '{}',
  status         text not null default 'active' check (status in ('active','paused','fulfilled')),
  created_at     timestamptz not null default now()
);

create table public.mandates (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references public.profiles(id) on delete cascade,
  wishlist_item_id       uuid not null references public.wishlist_items(id) on delete cascade,
  max_amount             numeric(10,2) not null check (max_amount > 0),
  currency               text not null default 'USD',
  require_human_approval boolean not null default true,
  expires_at             timestamptz not null,
  revoked_at             timestamptz,
  created_at             timestamptz not null default now()
);
create index on public.mandates (wishlist_item_id);

-- ───────────── marketplace & listings ─────────────
create table public.sellers (
  id               uuid primary key default gen_random_uuid(),
  display_name     text not null,
  account_age_days int  not null default 365,
  rating           numeric(2,1),
  rating_count     int  not null default 0,
  is_agent         boolean not null default true
);

-- SERVER-ONLY (no RLS policies → only service role can read)
create table public.seller_personas (
  seller_id uuid primary key references public.sellers(id) on delete cascade,
  style     text not null check (style in ('friendly','firm','pushy','scammer','injector')),
  notes     text not null default ''
);

create table public.listings (
  id           uuid primary key default gen_random_uuid(),
  source       text not null check (source in ('channel3','marketplace')),
  external_id  text not null,
  title        text not null,
  description  text not null default '',
  price        numeric(10,2) not null,
  currency     text not null default 'USD',
  condition    text check (condition in ('new','like_new','good','fair')),
  url          text,
  image_url    text,
  retailer     text,
  seller_id    uuid references public.sellers(id),
  negotiable   boolean not null default false,
  raw          jsonb not null default '{}',
  fetched_at   timestamptz not null default now(),
  unique (source, external_id)
);
create index on public.listings using gin (to_tsvector('english', title || ' ' || description));

-- SERVER-ONLY: seller agent's hidden floor + scripted opener (e.g. scam deposit request)
create table public.listing_secrets (
  listing_id             uuid primary key references public.listings(id) on delete cascade,
  floor_price            numeric(10,2) not null,
  scripted_first_message text
);

-- ───────────── pipeline ─────────────
create table public.matches (
  id               uuid primary key default gen_random_uuid(),
  wishlist_item_id uuid not null references public.wishlist_items(id) on delete cascade,
  listing_id       uuid not null references public.listings(id) on delete cascade,
  status           text not null default 'new' check (status in
                    ('new','mismatch','flagged','ready','negotiating','agreed','no_deal','notified','checkout_pending','purchased','skipped')),
  verdict          jsonb,   -- MatchVerdict
  risk             jsonb,   -- RiskAssessment
  best_price       numeric(10,2),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (wishlist_item_id, listing_id)   -- also the LLM cache key: never re-score a pair
);
create trigger matches_updated before update on public.matches for each row execute function public.set_updated_at();

create table public.negotiations (
  id           uuid primary key default gen_random_uuid(),
  match_id     uuid not null unique references public.matches(id) on delete cascade,
  status       text not null default 'active' check (status in ('active','agreed','no_deal','blocked')),
  round        int  not null default 0,
  max_rounds   int  not null default 6,
  agreed_price numeric(10,2),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger negotiations_updated before update on public.negotiations for each row execute function public.set_updated_at();

create table public.negotiation_messages (
  id             uuid primary key default gen_random_uuid(),
  negotiation_id uuid not null references public.negotiations(id) on delete cascade,
  round          int  not null,
  role           text not null check (role in ('buyer','seller','guardrail')),
  action         text not null,
  price          numeric(10,2),
  message        text not null default '',
  guardrail      jsonb,   -- GuardrailResult
  created_at     timestamptz not null default now()
);
create index on public.negotiation_messages (negotiation_id, created_at);

create table public.orders (
  id              uuid primary key default gen_random_uuid(),
  match_id        uuid not null references public.matches(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  paypal_order_id text not null unique,
  amount          numeric(10,2) not null,
  currency        text not null,
  status          text not null default 'created' check (status in ('created','approved','completed','failed','cancelled')),
  approve_url     text,
  capture_id      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger orders_updated before update on public.orders for each row execute function public.set_updated_at();

create table public.agent_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  match_id   uuid references public.matches(id) on delete cascade,
  type       text not null,
  message    text not null,
  payload    jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on public.agent_events (user_id, created_at desc);

-- PayPal webhook idempotency
create table public.webhook_events (
  id          text primary key,      -- PayPal event id
  type        text not null,
  received_at timestamptz not null default now()
);

-- ───────────── RLS ─────────────
alter table public.profiles             enable row level security;
alter table public.wishlist_items       enable row level security;
alter table public.mandates             enable row level security;
alter table public.sellers              enable row level security;
alter table public.seller_personas      enable row level security;  -- no policies: server-only
alter table public.listings             enable row level security;
alter table public.listing_secrets      enable row level security;  -- no policies: server-only
alter table public.matches              enable row level security;
alter table public.negotiations         enable row level security;
alter table public.negotiation_messages enable row level security;
alter table public.orders               enable row level security;
alter table public.agent_events         enable row level security;
alter table public.webhook_events       enable row level security;  -- no policies: server-only

create policy "own profile"   on public.profiles       for select using (id = auth.uid());
create policy "own profile u" on public.profiles       for update using (id = auth.uid());
create policy "own wishlist"  on public.wishlist_items for all    using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own mandates"  on public.mandates       for select using (user_id = auth.uid());
create policy "public sellers"  on public.sellers  for select using (true);
create policy "public listings" on public.listings for select using (true);
create policy "own matches" on public.matches for select using (
  exists (select 1 from public.wishlist_items w where w.id = wishlist_item_id and w.user_id = auth.uid()));
create policy "own negotiations" on public.negotiations for select using (
  exists (select 1 from public.matches m join public.wishlist_items w on w.id = m.wishlist_item_id
          where m.id = match_id and w.user_id = auth.uid()));
create policy "own negotiation messages" on public.negotiation_messages for select using (
  exists (select 1 from public.negotiations n join public.matches m on m.id = n.match_id
          join public.wishlist_items w on w.id = m.wishlist_item_id
          where n.id = negotiation_id and w.user_id = auth.uid()));
create policy "own orders" on public.orders       for select using (user_id = auth.uid());
create policy "own events" on public.agent_events for select using (user_id = auth.uid());
-- All writes to matches/negotiations/messages/orders/events/mandates go through server routes using the service-role key.

-- ───────────── realtime (live negotiation transcript + activity feed) ─────────────
alter publication supabase_realtime add table public.negotiation_messages, public.agent_events, public.matches;
