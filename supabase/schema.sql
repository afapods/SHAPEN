-- SHAPEN: schema inicial para contas, perfis e assinaturas.
-- Execute no SQL Editor do Supabase. Todas as tabelas expostas usam RLS.
create extension if not exists pgcrypto;

create table if not exists public.shapen_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  fitness_profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.shapen_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  plan text not null check (plan in ('basico','premium','ultimate')),
  provider text not null default 'mercadopago',
  provider_subscription_id text,
  provider_payment_id text,
  external_reference text,
  cancelled_at timestamptz,
  payment_method text not null check (payment_method in ('card','pix')),
  status text not null default 'pending' check (status in ('pending','authorized','active','paused','cancelled','expired','rejected')),
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists shapen_subscriptions_provider_subscription_id_idx
  on public.shapen_subscriptions(provider, provider_subscription_id)
  where provider_subscription_id is not null;

alter table public.shapen_subscriptions add column if not exists external_reference text;
alter table public.shapen_subscriptions add column if not exists cancelled_at timestamptz;
create unique index if not exists shapen_subscriptions_external_reference_idx
  on public.shapen_subscriptions(external_reference) where external_reference is not null;

create index if not exists shapen_subscriptions_user_status_idx
  on public.shapen_subscriptions(user_id, status, created_at desc);

alter table public.shapen_profiles enable row level security;
alter table public.shapen_subscriptions enable row level security;

drop policy if exists "Users can read their own profile" on public.shapen_profiles;
create policy "Users can read their own profile"
  on public.shapen_profiles for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own profile" on public.shapen_profiles;
create policy "Users can insert their own profile"
  on public.shapen_profiles for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own profile" on public.shapen_profiles;
create policy "Users can update their own profile"
  on public.shapen_profiles for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- A assinatura só pode ser consultada pelo próprio usuário.
-- Escritas de status e pagamento serão feitas exclusivamente pelo servidor.
drop policy if exists "Users can read their own subscriptions" on public.shapen_subscriptions;
create policy "Users can read their own subscriptions"
  on public.shapen_subscriptions for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.shapen_profiles from anon;
revoke all on public.shapen_subscriptions from anon;
grant select, insert, update on public.shapen_profiles to authenticated;
grant select on public.shapen_subscriptions to authenticated;
grant all on public.shapen_profiles to service_role;
grant all on public.shapen_subscriptions to service_role;
