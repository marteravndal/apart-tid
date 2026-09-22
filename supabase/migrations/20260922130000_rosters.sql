create table public.shift_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  day_start time not null default '08:00',
  day_end time not null default '16:00',
  evening_start time not null default '16:00',
  evening_end time not null default '23:00',
  night_start time not null default '23:00',
  night_end time not null default '07:00',
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);

create table public.shift_schedules (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  week_start date not null check (extract(isodow from week_start) = 1),
  status text not null default 'draft' check (status in ('draft','published','inactive')),
  published_snapshot jsonb not null default '[]'::jsonb check (jsonb_typeof(published_snapshot) = 'array'),
  published_at timestamptz,
  published_by uuid references auth.users(id),
  created_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  unique (organization_id, week_start)
);

create table public.scheduled_shifts (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references public.shift_schedules(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  employee_id uuid not null references public.employees(id),
  work_date date not null,
  shift_type text not null check (shift_type in ('day','evening','night')),
  start_time time not null,
  end_time time not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (schedule_id, employee_id, work_date, start_time)
);

create index shift_schedules_org_week_idx on public.shift_schedules(organization_id, week_start desc);
create index scheduled_shifts_schedule_date_idx on public.scheduled_shifts(schedule_id, work_date, start_time);
create index scheduled_shifts_employee_date_idx on public.scheduled_shifts(employee_id, work_date);

alter table public.shift_settings enable row level security;
alter table public.shift_schedules enable row level security;
alter table public.scheduled_shifts enable row level security;
revoke all on public.shift_settings, public.shift_schedules, public.scheduled_shifts from anon, authenticated;
grant all on public.shift_settings, public.shift_schedules, public.scheduled_shifts to service_role;
create policy "Shift settings use protected service" on public.shift_settings for all to authenticated using (false) with check (false);
create policy "Shift schedules use protected service" on public.shift_schedules for all to authenticated using (false) with check (false);
create policy "Scheduled shifts use protected service" on public.scheduled_shifts for all to authenticated using (false) with check (false);
