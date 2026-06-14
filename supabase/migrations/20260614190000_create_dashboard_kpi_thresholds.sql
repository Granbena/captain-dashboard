create table if not exists public.dashboard_kpi_thresholds (
  metric_key text primary key,
  label text not null,
  unit text not null check (unit in ('percent', 'minutes')),
  direction text not null check (direction in ('higher_is_better', 'lower_is_better')),
  thresholds jsonb not null,
  sort_order integer not null default 0,
  active boolean not null default true,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

alter table public.dashboard_kpi_thresholds enable row level security;

create policy "admin active can read dashboard kpi thresholds"
on public.dashboard_kpi_thresholds
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
      and p.active = true
  )
);

insert into public.dashboard_kpi_thresholds (
  metric_key,
  label,
  unit,
  direction,
  thresholds,
  sort_order,
  active,
  updated_at
)
values
  (
    'onTime',
    'OnTime',
    'percent',
    'higher_is_better',
    '{"redBelow":80,"yellowBelow":85,"greenMin":85}'::jsonb,
    10,
    true,
    now()
  ),
  (
    'e2e',
    'E2E',
    'minutes',
    'lower_is_better',
    '{"greenMax":43,"yellowAbove":43,"redAbove":50}'::jsonb,
    20,
    true,
    now()
  ),
  (
    'pick',
    'Pick',
    'minutes',
    'lower_is_better',
    '{"greenBelow":20,"yellowMin":20,"redAbove":30}'::jsonb,
    30,
    true,
    now()
  ),
  (
    'delivery',
    'Delivery',
    'minutes',
    'lower_is_better',
    '{"greenBelow":12,"yellowMin":12,"redAbove":18}'::jsonb,
    40,
    true,
    now()
  ),
  (
    'activeAge',
    'Activas/antigüedad',
    'minutes',
    'lower_is_better',
    '{"greenBelow":31,"yellowMin":31,"redMin":43}'::jsonb,
    50,
    true,
    now()
  )
on conflict (metric_key) do update
set
  label = excluded.label,
  unit = excluded.unit,
  direction = excluded.direction,
  thresholds = excluded.thresholds,
  sort_order = excluded.sort_order,
  active = excluded.active,
  updated_at = now();
