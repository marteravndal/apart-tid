create type public.user_role as enum ('employee','manager','admin');
create type public.entry_kind as enum ('work','sick_pay');
create type public.entry_source as enum ('qr','manual','automatic');
create type public.payroll_category as enum ('ordinary','overtime_40','sick_pay','overtime_100');
create type public.approval_status as enum ('open','approved','locked');

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'Europe/Oslo',
  created_at timestamptz not null default now()
);

create table public.employees (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id),
  organization_id uuid not null references public.organizations(id),
  employee_number text not null,
  full_name text not null,
  email text not null,
  phone_number text,
  role public.user_role not null default 'employee',
  active boolean not null default true,
  deactivated_at timestamptz,
  deactivated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, employee_number),
  unique (organization_id, email)
);
create unique index employees_org_email_lower_key on public.employees(organization_id,lower(email));
create index idx_employees_auth_user on public.employees(auth_user_id);
create index idx_employees_org_active on public.employees(organization_id,active);

create table public.worksites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  name text not null,
  address text not null,
  latitude double precision,
  longitude double precision,
  radius_meters integer not null default 100 check (radius_meters between 20 and 1000),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index idx_worksites_organization on public.worksites(organization_id);

create table public.qr_codes (
  id uuid primary key default gen_random_uuid(),
  worksite_id uuid not null references public.worksites(id),
  token_hash text not null unique,
  valid_from timestamptz not null,
  expires_at timestamptz not null,
  created_by uuid not null references auth.users(id),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  location_check_required boolean not null default true
);
create index idx_qr_codes_worksite on public.qr_codes(worksite_id);
create index idx_qr_codes_created_by on public.qr_codes(created_by);

create table public.time_entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null references public.employees(id),
  worksite_id uuid references public.worksites(id),
  kind public.entry_kind not null default 'work',
  started_at timestamptz not null,
  ended_at timestamptz,
  clock_in_latitude double precision,
  clock_in_longitude double precision,
  clock_out_latitude double precision,
  clock_out_longitude double precision,
  source public.entry_source not null,
  auto_clocked_out boolean not null default false,
  note text,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ended_at is null or ended_at >= started_at)
);
create index idx_time_entries_employee_started on public.time_entries(employee_id,started_at desc);
create index idx_time_entries_organization_started on public.time_entries(organization_id,started_at desc);
create index idx_time_entries_worksite on public.time_entries(worksite_id);
create index idx_time_entries_created_by on public.time_entries(created_by);
create unique index idx_time_entries_one_open_per_employee on public.time_entries(employee_id) where ended_at is null;

create table public.payroll_settings (
  organization_id uuid not null references public.organizations(id),
  category public.payroll_category not null,
  payroll_code text,
  label text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  primary key (organization_id,category)
);
create index idx_payroll_settings_updated_by on public.payroll_settings(updated_by);

create table public.payroll_adjustments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null references public.employees(id),
  work_date date not null,
  category public.payroll_category not null,
  hours numeric not null check (hours > 0),
  note text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  constraint payroll_adjustments_category_check check (category='overtime_100'::public.payroll_category)
);
create index idx_payroll_adjustments_employee_date on public.payroll_adjustments(employee_id,work_date);
create index idx_payroll_adjustments_organization on public.payroll_adjustments(organization_id);
create index idx_payroll_adjustments_created_by on public.payroll_adjustments(created_by);

create table public.month_approvals (
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null references public.employees(id),
  month_start date not null check (month_start=date_trunc('month',month_start::timestamptz)::date),
  status public.approval_status not null default 'open',
  approved_by uuid references auth.users(id),
  approved_at timestamptz,
  primary key (employee_id,month_start)
);
create index idx_month_approvals_organization on public.month_approvals(organization_id);
create index idx_month_approvals_approved_by on public.month_approvals(approved_by);

create table public.month_locks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  month_start date not null check (month_start=date_trunc('month',month_start::timestamptz)::date),
  revision integer not null default 1 check (revision > 0),
  locked_by uuid not null references auth.users(id),
  locked_at timestamptz not null default now(),
  superseded_at timestamptz,
  unique (organization_id,month_start,revision)
);
create unique index idx_month_locks_current on public.month_locks(organization_id,month_start) where superseded_at is null;
create index idx_month_locks_locked_by on public.month_locks(locked_by);

create table public.month_snapshot_rows (
  id uuid primary key default gen_random_uuid(),
  lock_id uuid not null references public.month_locks(id) on delete cascade,
  employee_id uuid not null references public.employees(id),
  employee_number text not null,
  employee_name text not null,
  ordinary_hours numeric not null default 0,
  overtime_40_hours numeric not null default 0,
  sick_pay_hours numeric not null default 0,
  overtime_100_hours numeric not null default 0,
  payroll_codes jsonb not null default '{}'::jsonb,
  unique (lock_id,employee_id)
);
create index idx_month_snapshot_rows_employee on public.month_snapshot_rows(employee_id,lock_id);

create table public.report_recipients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  email text not null,
  recipient_type text not null check (recipient_type in ('admin','accountant')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (organization_id,email)
);
create index idx_report_recipients_created_by on public.report_recipients(created_by);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id),
  actor_id uuid references auth.users(id),
  action text not null,
  entity_type text not null,
  entity_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index idx_audit_logs_organization_created on public.audit_logs(organization_id,created_at desc);
create index idx_audit_logs_actor on public.audit_logs(actor_id);

create table public.daily_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  work_date date not null,
  status text not null default 'draft' check (status in ('draft','locked','sent','reopened')),
  revision integer not null default 1 check (revision > 0),
  locked_by uuid references auth.users(id),
  locked_at timestamptz,
  sent_by uuid references auth.users(id),
  sent_at timestamptz,
  recipients text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id,work_date,revision)
);
create index daily_reports_org_date_idx on public.daily_reports(organization_id,work_date desc);

create table public.daily_report_rows (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.daily_reports(id) on delete cascade,
  employee_id uuid not null references public.employees(id),
  employee_number text not null,
  employee_name text not null,
  start_time timestamptz,
  end_time timestamptz,
  worked_hours numeric not null default 0 check (worked_hours >= 0),
  sick_pay_hours numeric not null default 0 check (sick_pay_hours >= 0),
  auto_clocked_out boolean not null default false,
  source_entry_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (report_id,employee_id)
);
create index daily_report_rows_report_idx on public.daily_report_rows(report_id);

create table public.transport_transfer_proposals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  report_id uuid not null references public.daily_reports(id),
  report_row_id uuid not null references public.daily_report_rows(id),
  employee_id uuid not null references public.employees(id),
  employee_number text not null,
  work_date date not null,
  start_time timestamptz,
  end_time timestamptz,
  worked_hours numeric not null check (worked_hours >= 0),
  status text not null default 'prepared' check (status in ('prepared','transferred','rejected','superseded','failed')),
  target_reference text,
  transferred_at timestamptz,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (report_id,employee_id)
);
create index transport_transfer_proposals_status_idx on public.transport_transfer_proposals(organization_id,status,work_date);

create table public.hms_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  title text not null check (char_length(title) between 2 and 200),
  storage_path text not null unique,
  original_name text not null,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 10485760),
  active boolean not null default true,
  uploaded_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_hms_documents_org_active on public.hms_documents(organization_id,active,created_at desc);

create table public.hms_deviations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null references public.employees(id),
  title text not null check (char_length(title) between 3 and 200),
  category text not null check (category in ('fare','skade','miljo','utstyr','annet')),
  severity text not null check (severity in ('lav','middels','hoy')),
  description text not null check (char_length(description) between 10 and 5000),
  status text not null default 'new' check (status in ('new','in_progress','closed')),
  admin_comment text,
  handled_by uuid references auth.users(id),
  handled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_hms_deviations_employee on public.hms_deviations(employee_id,created_at desc);
create index idx_hms_deviations_org_status on public.hms_deviations(organization_id,status,created_at desc);

alter table public.organizations enable row level security;
alter table public.employees enable row level security;
alter table public.worksites enable row level security;
alter table public.qr_codes enable row level security;
alter table public.time_entries enable row level security;
alter table public.payroll_settings enable row level security;
alter table public.payroll_adjustments enable row level security;
alter table public.month_approvals enable row level security;
alter table public.month_locks enable row level security;
alter table public.month_snapshot_rows enable row level security;
alter table public.report_recipients enable row level security;
alter table public.audit_logs enable row level security;
alter table public.daily_reports enable row level security;
alter table public.daily_report_rows enable row level security;
alter table public.transport_transfer_proposals enable row level security;
alter table public.hms_documents enable row level security;
alter table public.hms_deviations enable row level security;

revoke all on all tables in schema public from anon,authenticated;
grant select on public.employees to authenticated;
grant all on all tables in schema public to service_role;
grant usage,select on all sequences in schema public to service_role;
create policy employees_self_read on public.employees for select to authenticated using (auth_user_id=(select auth.uid()));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('hms-documents','hms-documents',false,10485760,array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/jpeg','image/png'])
on conflict(id) do update set public=false,file_size_limit=10485760,allowed_mime_types=excluded.allowed_mime_types;

create or replace function public.prepare_daily_report(p_organization_id uuid,p_work_date date,p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path='public','pg_temp' as $$
declare v_report public.daily_reports;v_revision integer;v_rows integer;
begin
  if not exists(select 1 from public.employees where auth_user_id=p_actor_id and organization_id=p_organization_id and role='admin' and active=true) then raise exception 'Kun aktiv administrator kan låse dagsrapporten.';end if;
  select * into v_report from public.daily_reports where organization_id=p_organization_id and work_date=p_work_date and status in ('locked','sent') order by revision desc limit 1;
  if found then select count(*) into v_rows from public.transport_transfer_proposals where report_id=v_report.id;return jsonb_build_object('report_id',v_report.id,'revision',v_report.revision,'proposal_count',v_rows,'already_locked',true);end if;
  if exists(select 1 from public.time_entries where organization_id=p_organization_id and (started_at at time zone 'Europe/Oslo')::date=p_work_date and ended_at is null) then raise exception 'Dagen har åpne tidsregistreringer og kan ikke låses.';end if;
  if not exists(select 1 from public.time_entries where organization_id=p_organization_id and (started_at at time zone 'Europe/Oslo')::date=p_work_date and ended_at is not null) then raise exception 'Det finnes ingen fullførte tidsregistreringer for valgt dato.';end if;
  select coalesce(max(revision),0)+1 into v_revision from public.daily_reports where organization_id=p_organization_id and work_date=p_work_date;
  insert into public.daily_reports(organization_id,work_date,status,revision,locked_by,locked_at) values(p_organization_id,p_work_date,'locked',v_revision,p_actor_id,now()) returning * into v_report;
  insert into public.daily_report_rows(report_id,employee_id,employee_number,employee_name,start_time,end_time,worked_hours,sick_pay_hours,auto_clocked_out,source_entry_ids)
  select v_report.id,e.id,e.employee_number,e.full_name,min(t.started_at) filter(where t.kind='work'),max(t.ended_at) filter(where t.kind='work'),round(coalesce(sum(extract(epoch from(t.ended_at-t.started_at))/3600) filter(where t.kind='work' and t.ended_at is not null),0)::numeric,2),round(coalesce(sum(extract(epoch from(t.ended_at-t.started_at))/3600) filter(where t.kind='sick_pay' and t.ended_at is not null),0)::numeric,2),bool_or(t.auto_clocked_out),array_agg(t.id order by t.started_at)
  from public.time_entries t join public.employees e on e.id=t.employee_id where t.organization_id=p_organization_id and (t.started_at at time zone 'Europe/Oslo')::date=p_work_date and t.ended_at is not null group by e.id,e.employee_number,e.full_name;
  insert into public.transport_transfer_proposals(organization_id,report_id,report_row_id,employee_id,employee_number,work_date,start_time,end_time,worked_hours)
  select p_organization_id,r.report_id,r.id,r.employee_id,r.employee_number,p_work_date,r.start_time,r.end_time,r.worked_hours from public.daily_report_rows r where r.report_id=v_report.id and r.worked_hours>0;
  get diagnostics v_rows=row_count;
  insert into public.audit_logs(organization_id,actor_id,action,entity_type,entity_id,details) values(p_organization_id,p_actor_id,'lock_daily_report','daily_report',v_report.id,jsonb_build_object('work_date',p_work_date,'revision',v_revision,'transport_proposals',v_rows));
  return jsonb_build_object('report_id',v_report.id,'revision',v_revision,'proposal_count',v_rows,'already_locked',false);
end;$$;
revoke execute on function public.prepare_daily_report(uuid,date,uuid) from public,anon,authenticated;
grant execute on function public.prepare_daily_report(uuid,date,uuid) to service_role;

with organization as (
  insert into public.organizations(name,timezone) values ('Apart Stavanger AS','Europe/Oslo') returning id
)
insert into public.payroll_settings(organization_id,category,payroll_code,label)
select id,category,code,label from organization cross join (values
  ('ordinary'::public.payroll_category,null::text,'Ordinære timer'),
  ('overtime_40'::public.payroll_category,null::text,'Overtid 40 %'),
  ('overtime_100'::public.payroll_category,null::text,'Overtid 100 %'),
  ('sick_pay'::public.payroll_category,null::text,'Sykepenger')
) as defaults(category,code,label);
