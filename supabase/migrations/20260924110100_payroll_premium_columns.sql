alter table public.payroll_settings
  add column if not exists hourly_rate numeric(12,2)
  check (hourly_rate is null or hourly_rate >= 0);

alter table public.month_snapshot_rows
  add column if not exists evening_hours numeric not null default 0,
  add column if not exists night_hours numeric not null default 0,
  add column if not exists weekend_hours numeric not null default 0;
