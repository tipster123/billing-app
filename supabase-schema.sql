-- Billing & Inventory: cloud tables for Supabase
-- Run this once in Supabase -> SQL Editor. Safe to run again later.

create table if not exists public.app_settings (
  id text primary key,
  business text,
  gstin text,
  prefix text,
  tax_rate numeric,
  currency text,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_settings enable row level security;
drop policy if exists "app all" on public.app_settings;
create policy "app all" on public.app_settings for all to anon using (true) with check (true);

create table if not exists public.branches (
  id text primary key,
  name text,
  address text,
  prefix text,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.branches enable row level security;
drop policy if exists "app all" on public.branches;
create policy "app all" on public.branches for all to anon using (true) with check (true);

create table if not exists public.staff (
  id text primary key,
  name text,
  username text,
  role text,
  branch_id text,
  target numeric,
  active boolean,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.staff enable row level security;
drop policy if exists "app all" on public.staff;
create policy "app all" on public.staff for all to anon using (true) with check (true);

create table if not exists public.items (
  id text primary key,
  name text,
  sku text,
  category text,
  price numeric,
  cost numeric,
  reorder numeric,
  stock jsonb,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.items enable row level security;
drop policy if exists "app all" on public.items;
create policy "app all" on public.items for all to anon using (true) with check (true);

create table if not exists public.customers (
  id text primary key,
  name text,
  phone text,
  email text,
  address text,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.customers enable row level security;
drop policy if exists "app all" on public.customers;
create policy "app all" on public.customers for all to anon using (true) with check (true);

create table if not exists public.suppliers (
  id text primary key,
  name text,
  phone text,
  email text,
  address text,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.suppliers enable row level security;
drop policy if exists "app all" on public.suppliers;
create policy "app all" on public.suppliers for all to anon using (true) with check (true);

create table if not exists public.invoices (
  id text primary key,
  no text,
  date text,
  customer_id text,
  customer_name text,
  branch_id text,
  staff_id text,
  discount numeric,
  tax numeric,
  total numeric,
  paid numeric,
  status text,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.invoices enable row level security;
drop policy if exists "app all" on public.invoices;
create policy "app all" on public.invoices for all to anon using (true) with check (true);

create table if not exists public.estimates (
  id text primary key,
  no text,
  date text,
  customer_id text,
  customer_name text,
  branch_id text,
  staff_id text,
  total numeric,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.estimates enable row level security;
drop policy if exists "app all" on public.estimates;
create policy "app all" on public.estimates for all to anon using (true) with check (true);

create table if not exists public.purchases (
  id text primary key,
  no text,
  date text,
  supplier_id text,
  supplier_name text,
  status text,
  total numeric,
  branch_id text,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.purchases enable row level security;
drop policy if exists "app all" on public.purchases;
create policy "app all" on public.purchases for all to anon using (true) with check (true);

create table if not exists public.sreturns (
  id text primary key,
  no text,
  date text,
  invoice_id text,
  customer_name text,
  branch_id text,
  total numeric,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.sreturns enable row level security;
drop policy if exists "app all" on public.sreturns;
create policy "app all" on public.sreturns for all to anon using (true) with check (true);

create table if not exists public.preturns (
  id text primary key,
  no text,
  date text,
  supplier_id text,
  total numeric,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.preturns enable row level security;
drop policy if exists "app all" on public.preturns;
create policy "app all" on public.preturns for all to anon using (true) with check (true);

create table if not exists public.transfers (
  id text primary key,
  no text,
  date text,
  from_branch text,
  to_branch text,
  status text,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.transfers enable row level security;
drop policy if exists "app all" on public.transfers;
create policy "app all" on public.transfers for all to anon using (true) with check (true);

create table if not exists public.damages (
  id text primary key,
  date text,
  item_id text,
  item_name text,
  qty numeric,
  cost_value numeric,
  branch_id text,
  adjusted boolean,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.damages enable row level security;
drop policy if exists "app all" on public.damages;
create policy "app all" on public.damages for all to anon using (true) with check (true);

create table if not exists public.expenses (
  id text primary key,
  date text,
  category text,
  amount numeric,
  method text,
  branch_id text,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.expenses enable row level security;
drop policy if exists "app all" on public.expenses;
create policy "app all" on public.expenses for all to anon using (true) with check (true);

create table if not exists public.staff_ledger (
  id text primary key,
  date text,
  staff_id text,
  type text,
  amount numeric,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.staff_ledger enable row level security;
drop policy if exists "app all" on public.staff_ledger;
create policy "app all" on public.staff_ledger for all to anon using (true) with check (true);

create table if not exists public.activity (
  id text primary key,
  at bigint,
  date text,
  type text,
  text text,
  who text,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.activity enable row level security;
drop policy if exists "app all" on public.activity;
create policy "app all" on public.activity for all to anon using (true) with check (true);

create table if not exists public.complaints (
  id text primary key,
  no text,
  date text,
  status text,
  item_name text,
  customer_name text,
  invoice_no text,
  supplier_name text,
  branch_id text,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.complaints enable row level security;
drop policy if exists "app all" on public.complaints;
create policy "app all" on public.complaints for all to anon using (true) with check (true);
