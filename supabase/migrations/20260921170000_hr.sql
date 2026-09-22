create table if not exists public.hr_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null references public.employees(id),
  batch_id uuid not null default gen_random_uuid(),
  title text not null check (char_length(title) between 2 and 200),
  document_type text not null default 'general' check (document_type in ('general','contract','policy','other')),
  storage_path text not null,
  original_name text not null,
  mime_type text not null check (mime_type = 'application/pdf'),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  requires_signature boolean not null default false,
  signature_status text not null default 'not_required' check (signature_status in ('not_required','pending','signed','declined')),
  provider text,
  provider_reference text,
  read_at timestamptz,
  signed_at timestamptz,
  uploaded_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists hr_documents_employee_created_idx on public.hr_documents(employee_id, created_at desc);
create index if not exists hr_documents_organization_idx on public.hr_documents(organization_id);
create index if not exists hr_documents_uploaded_by_idx on public.hr_documents(uploaded_by);
alter table public.hr_documents enable row level security;
revoke all on public.hr_documents from anon, authenticated;
create policy "HR documents use protected service" on public.hr_documents for all to authenticated using (false) with check (false);

create table if not exists public.hr_contracts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null references public.employees(id),
  title text not null check (char_length(title) between 2 and 200),
  content text not null default '',
  locked_content text,
  status text not null default 'draft' check (status in ('draft','locked','pending_signature','signed','cancelled')),
  version integer not null default 1 check (version > 0),
  locked_at timestamptz,
  signed_at timestamptz,
  provider text,
  provider_reference text,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists hr_contracts_employee_created_idx on public.hr_contracts(employee_id, created_at desc);
create index if not exists hr_contracts_organization_status_idx on public.hr_contracts(organization_id, status);
create index if not exists hr_contracts_created_by_idx on public.hr_contracts(created_by);
create index if not exists hr_contracts_updated_by_idx on public.hr_contracts(updated_by);
alter table public.hr_contracts enable row level security;
revoke all on public.hr_contracts from anon, authenticated;
create policy "HR contracts use protected service" on public.hr_contracts for all to authenticated using (false) with check (false);

insert into storage.buckets (id,name,public,file_size_limit,allowed_mime_types)
values ('hr-documents','hr-documents',false,10485760,array['application/pdf'])
on conflict (id) do update set public=false,file_size_limit=10485760,allowed_mime_types=array['application/pdf'];
