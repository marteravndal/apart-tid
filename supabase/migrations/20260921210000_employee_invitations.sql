alter table public.employees
  add column if not exists invited_at timestamptz,
  add column if not exists invited_by uuid references auth.users(id);

update public.employees
set invited_at = coalesce(invited_at, created_at)
where auth_user_id is not null and invited_at is null;

create index if not exists employees_invited_by_idx on public.employees(invited_by);
