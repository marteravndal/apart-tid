alter table public.hr_contracts
  add column if not exists modules jsonb not null default '[]'::jsonb,
  add column if not exists locked_modules jsonb;

alter table public.hr_contracts
  add constraint hr_contracts_modules_array check (jsonb_typeof(modules) = 'array'),
  add constraint hr_contracts_locked_modules_array check (locked_modules is null or jsonb_typeof(locked_modules) = 'array');
