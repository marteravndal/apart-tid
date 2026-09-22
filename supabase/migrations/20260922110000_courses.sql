create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  family_id uuid not null default gen_random_uuid(),
  parent_version_id uuid references public.courses(id),
  title text not null check (char_length(title) between 2 and 200),
  description text not null default '' check (char_length(description) <= 2000),
  modules jsonb not null default '[]'::jsonb check (jsonb_typeof(modules) = 'array'),
  questions jsonb not null default '[]'::jsonb check (jsonb_typeof(questions) = 'array'),
  passing_score integer not null default 80 check (passing_score between 1 and 100),
  status text not null default 'draft' check (status in ('draft','locked','archived')),
  version integer not null default 1 check (version > 0),
  locked_at timestamptz,
  created_by uuid references auth.users(id),
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.course_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  course_id uuid not null references public.courses(id),
  employee_id uuid not null references public.employees(id),
  status text not null default 'assigned' check (status in ('assigned','in_progress','completed')),
  assigned_by uuid references auth.users(id),
  assigned_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  score integer check (score between 0 and 100),
  attempts integer not null default 0 check (attempts >= 0),
  unique (course_id, employee_id)
);

create table if not exists public.course_attempts (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.course_assignments(id) on delete cascade,
  employee_id uuid not null references public.employees(id),
  score integer not null check (score between 0 and 100),
  passed boolean not null,
  answers jsonb not null default '[]'::jsonb check (jsonb_typeof(answers) = 'array'),
  submitted_at timestamptz not null default now()
);

create index if not exists courses_org_status_updated_idx on public.courses(organization_id,status,updated_at desc);
create unique index if not exists courses_family_version_idx on public.courses(family_id,version);
create index if not exists courses_parent_version_idx on public.courses(parent_version_id);
create index if not exists courses_created_by_idx on public.courses(created_by);
create index if not exists courses_updated_by_idx on public.courses(updated_by);
create index if not exists course_assignments_employee_status_idx on public.course_assignments(employee_id,status,assigned_at desc);
create index if not exists course_assignments_org_course_idx on public.course_assignments(organization_id,course_id);
create index if not exists course_assignments_assigned_by_idx on public.course_assignments(assigned_by);
create index if not exists course_attempts_assignment_idx on public.course_attempts(assignment_id,submitted_at desc);
create index if not exists course_attempts_employee_idx on public.course_attempts(employee_id,submitted_at desc);

alter table public.courses enable row level security;
alter table public.course_assignments enable row level security;
alter table public.course_attempts enable row level security;
revoke all on public.courses, public.course_assignments, public.course_attempts from anon, authenticated;
create policy "Courses use protected service" on public.courses for all to authenticated using (false) with check (false);
create policy "Course assignments use protected service" on public.course_assignments for all to authenticated using (false) with check (false);
create policy "Course attempts use protected service" on public.course_attempts for all to authenticated using (false) with check (false);
