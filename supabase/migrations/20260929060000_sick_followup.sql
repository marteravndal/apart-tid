create table public.sick_followup_cases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  employee_id uuid not null references public.employees(id),
  initial_request_id uuid not null unique references public.sick_leave_requests(id),
  start_date date not null,
  current_end_date date not null,
  sick_leave_percentage smallint not null default 100 check (sick_leave_percentage between 1 and 100),
  status text not null default 'active' check (status in ('active','closed')),
  followup_plan_required boolean not null default true,
  followup_plan_exemption_reason text,
  dialog1_required boolean not null default true,
  dialog1_exemption_reason text,
  next_followup_date date,
  closed_at timestamptz,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (current_end_date >= start_date),
  check (followup_plan_required or nullif(trim(followup_plan_exemption_reason),'') is not null),
  check (dialog1_required or nullif(trim(dialog1_exemption_reason),'') is not null)
);

create table public.sick_followup_case_requests (
  case_id uuid not null references public.sick_followup_cases(id) on delete cascade,
  request_id uuid not null unique references public.sick_leave_requests(id),
  organization_id uuid not null references public.organizations(id),
  created_at timestamptz not null default now(),
  primary key (case_id,request_id)
);

create table public.sick_followup_plans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  case_id uuid not null references public.sick_followup_cases(id) on delete cascade,
  version integer not null check (version > 0),
  status text not null default 'draft' check (status in ('draft','shared','acknowledged')),
  ordinary_tasks text,
  work_ability text,
  accommodation_options text,
  agreed_measures text,
  external_assistance text,
  return_goal text,
  next_review_date date,
  shared_with_sick_note_at timestamptz,
  shared_with_nav_at timestamptz,
  employee_acknowledged_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (case_id,version)
);

create table public.sick_followup_activities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  case_id uuid not null references public.sick_followup_cases(id) on delete cascade,
  activity_type text not null check (activity_type in ('contact','dialog1','activity_review','nav_dialog2','nav_dialog3','plan_shared_sick_note','plan_shared_nav','employee_response','other')),
  occurred_on date not null,
  title text not null check (char_length(title) between 2 and 200),
  summary text check (summary is null or char_length(summary) <= 5000),
  participants text check (participants is null or char_length(participants) <= 1000),
  sick_note_consent boolean not null default false,
  next_followup_date date,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.sick_followup_measures (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  case_id uuid not null references public.sick_followup_cases(id) on delete cascade,
  title text not null check (char_length(title) between 2 and 200),
  description text check (description is null or char_length(description) <= 5000),
  responsible_party text not null default 'shared' check (responsible_party in ('employer','employee','shared','external')),
  start_date date,
  evaluation_date date,
  status text not null default 'planned' check (status in ('planned','active','completed','cancelled')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index sick_followup_cases_org_status_idx on public.sick_followup_cases(organization_id,status,start_date);
create index sick_followup_cases_employee_idx on public.sick_followup_cases(employee_id,status,start_date desc);
create index sick_followup_case_requests_org_idx on public.sick_followup_case_requests(organization_id,case_id);
create index sick_followup_plans_case_idx on public.sick_followup_plans(case_id,version desc);
create index sick_followup_plans_org_idx on public.sick_followup_plans(organization_id,created_at desc);
create index sick_followup_activities_case_idx on public.sick_followup_activities(case_id,occurred_on desc);
create index sick_followup_activities_org_idx on public.sick_followup_activities(organization_id,created_at desc);
create index sick_followup_measures_case_idx on public.sick_followup_measures(case_id,status,evaluation_date);
create index sick_followup_measures_org_idx on public.sick_followup_measures(organization_id,created_at desc);
create index sick_followup_cases_created_by_idx on public.sick_followup_cases(created_by);
create index sick_followup_plans_created_by_idx on public.sick_followup_plans(created_by);
create index sick_followup_activities_created_by_idx on public.sick_followup_activities(created_by);
create index sick_followup_measures_created_by_idx on public.sick_followup_measures(created_by);

alter table public.sick_followup_cases enable row level security;
alter table public.sick_followup_case_requests enable row level security;
alter table public.sick_followup_plans enable row level security;
alter table public.sick_followup_activities enable row level security;
alter table public.sick_followup_measures enable row level security;

revoke all on table public.sick_followup_cases,public.sick_followup_case_requests,public.sick_followup_plans,public.sick_followup_activities,public.sick_followup_measures from anon,authenticated;
grant all on table public.sick_followup_cases,public.sick_followup_case_requests,public.sick_followup_plans,public.sick_followup_activities,public.sick_followup_measures to service_role;
create policy "Sick follow-up cases use protected service" on public.sick_followup_cases for all to authenticated using (false) with check (false);
create policy "Sick follow-up links use protected service" on public.sick_followup_case_requests for all to authenticated using (false) with check (false);
create policy "Sick follow-up plans use protected service" on public.sick_followup_plans for all to authenticated using (false) with check (false);
create policy "Sick follow-up activities use protected service" on public.sick_followup_activities for all to authenticated using (false) with check (false);
create policy "Sick follow-up measures use protected service" on public.sick_followup_measures for all to authenticated using (false) with check (false);

create or replace function public.ensure_sick_followup_case(p_request_id uuid,p_actor_id uuid)
returns uuid
language plpgsql
security definer
set search_path='public','pg_temp'
as $$
declare
  v_request public.sick_leave_requests%rowtype;
  v_case public.sick_followup_cases%rowtype;
begin
  select * into v_request from public.sick_leave_requests where id=p_request_id;
  if not found or v_request.absence_type <> 'medical_certificate' or v_request.status <> 'approved' then return null; end if;

  select c.* into v_case
  from public.sick_followup_cases c
  where c.organization_id=v_request.organization_id and c.employee_id=v_request.employee_id and c.status='active'
    and c.start_date <= v_request.end_date + 16
    and c.current_end_date >= v_request.start_date - 16
  order by c.start_date desc limit 1 for update;

  if not found then
    insert into public.sick_followup_cases(organization_id,employee_id,initial_request_id,start_date,current_end_date,created_by)
    values(v_request.organization_id,v_request.employee_id,v_request.id,v_request.start_date,v_request.end_date,p_actor_id)
    returning * into v_case;
  else
    update public.sick_followup_cases
      set start_date=least(start_date,v_request.start_date),current_end_date=greatest(current_end_date,v_request.end_date),updated_at=now()
      where id=v_case.id returning * into v_case;
  end if;

  insert into public.sick_followup_case_requests(case_id,request_id,organization_id)
  values(v_case.id,v_request.id,v_request.organization_id) on conflict(request_id) do nothing;
  return v_case.id;
end;
$$;

revoke execute on function public.ensure_sick_followup_case(uuid,uuid) from public,anon,authenticated;
grant execute on function public.ensure_sick_followup_case(uuid,uuid) to service_role;

do $$
declare r record;
begin
  for r in select id,handled_by from public.sick_leave_requests where absence_type='medical_certificate' and status='approved' loop
    perform public.ensure_sick_followup_case(r.id,r.handled_by);
  end loop;
end $$;
