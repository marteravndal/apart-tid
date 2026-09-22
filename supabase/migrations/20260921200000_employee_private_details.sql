create table if not exists public.employee_private_details (
  employee_id uuid primary key references public.employees(id) on delete cascade,
  organization_id uuid not null references public.organizations(id),
  address text,
  postal_code text check (postal_code is null or postal_code ~ '^[0-9]{4}$'),
  city text,
  bank_account text check (bank_account is null or bank_account ~ '^[0-9]{11}$'),
  national_identity_number text check (national_identity_number is null or national_identity_number ~ '^[0-9]{11}$'),
  employed_from date,
  position_percent numeric(5,2) check (position_percent is null or position_percent > 0 and position_percent <= 100),
  salary_type text check (salary_type is null or salary_type in ('hourly','monthly')),
  salary_rate numeric(12,2) check (salary_rate is null or salary_rate >= 0),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists employee_private_details_organization_idx on public.employee_private_details(organization_id);
create index if not exists employee_private_details_updated_by_idx on public.employee_private_details(updated_by);
alter table public.employee_private_details enable row level security;
revoke all on public.employee_private_details from anon, authenticated;
create policy "Employee private details use protected service" on public.employee_private_details for all to authenticated using (false) with check (false);

alter table public.hr_contracts add column if not exists locked_employee_snapshot jsonb;
