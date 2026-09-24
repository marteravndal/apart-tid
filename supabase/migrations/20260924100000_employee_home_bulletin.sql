create table if not exists public.employee_section_views (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null references public.employees(id) on delete cascade,
  section text not null check (section in ('courses','hr','hms','bulletin')),
  viewed_at timestamptz not null default now(),
  unique (employee_id, section)
);

create index if not exists employee_section_views_org_idx
  on public.employee_section_views(organization_id, employee_id);

alter table public.employee_section_views enable row level security;
revoke all on public.employee_section_views from anon, authenticated;
create policy "Section views use protected service"
  on public.employee_section_views for all to authenticated
  using (false) with check (false);

insert into public.employee_section_views (organization_id, employee_id, section, viewed_at)
select employees.organization_id, employees.id, sections.section, now()
from public.employees
cross join (values ('courses'),('hr'),('hms'),('bulletin')) as sections(section)
on conflict (employee_id, section) do nothing;

create table if not exists public.bulletin_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  title text not null check (char_length(title) between 2 and 200),
  storage_path text not null unique,
  original_name text not null,
  mime_type text not null check (mime_type in (
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png'
  )),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  active boolean not null default true,
  uploaded_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bulletin_documents_org_created_idx
  on public.bulletin_documents(organization_id, active, created_at desc);
create index if not exists bulletin_documents_uploaded_by_idx
  on public.bulletin_documents(uploaded_by);

alter table public.bulletin_documents enable row level security;
revoke all on public.bulletin_documents from anon, authenticated;
create policy "Bulletin documents use protected service"
  on public.bulletin_documents for all to authenticated
  using (false) with check (false);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'bulletin-documents',
  'bulletin-documents',
  false,
  10485760,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/png'
  ]
)
on conflict (id) do update set
  public = false,
  file_size_limit = 10485760,
  allowed_mime_types = excluded.allowed_mime_types;
