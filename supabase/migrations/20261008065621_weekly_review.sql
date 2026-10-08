-- Administrative weekly review. All writes and reads go through the authenticated edge service.
CREATE TABLE public.weekly_item_approvals (
 organization_id uuid NOT NULL REFERENCES public.organizations(id), employee_id uuid NOT NULL REFERENCES public.employees(id),
 week_start date NOT NULL, item_type text NOT NULL CHECK(item_type IN ('entry','adjustment')), item_id uuid NOT NULL,
 fingerprint text NOT NULL, approved_by uuid NOT NULL REFERENCES auth.users(id), approved_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(item_type,item_id)
);
CREATE INDEX weekly_item_approvals_week ON public.weekly_item_approvals(organization_id,week_start,employee_id);
CREATE TABLE public.weekly_shift_resolutions (
 organization_id uuid NOT NULL REFERENCES public.organizations(id), employee_id uuid NOT NULL REFERENCES public.employees(id),
 week_start date NOT NULL, shift_key text NOT NULL, fingerprint text NOT NULL, reason text NOT NULL CHECK(length(trim(reason)) BETWEEN 3 AND 1000),
 resolved_by uuid NOT NULL REFERENCES auth.users(id), resolved_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(organization_id,week_start,shift_key)
);
CREATE TABLE public.weekly_employee_locks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id),
 employee_id uuid NOT NULL REFERENCES public.employees(id), week_start date NOT NULL CHECK(extract(isodow FROM week_start)=1),
 revision integer NOT NULL, snapshot jsonb NOT NULL, locked_by uuid NOT NULL REFERENCES auth.users(id), locked_at timestamptz NOT NULL DEFAULT now(),
 superseded_at timestamptz, reopened_by uuid REFERENCES auth.users(id), reopen_reason text
);
CREATE UNIQUE INDEX weekly_employee_lock_active ON public.weekly_employee_locks(organization_id,week_start,employee_id) WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX weekly_employee_lock_revision ON public.weekly_employee_locks(organization_id,week_start,employee_id,revision);
CREATE TABLE public.weekly_period_locks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL REFERENCES public.organizations(id),
 week_start date NOT NULL CHECK(extract(isodow FROM week_start)=1), revision integer NOT NULL, report jsonb NOT NULL,
 locked_by uuid NOT NULL REFERENCES auth.users(id), locked_at timestamptz NOT NULL DEFAULT now(),
 superseded_at timestamptz, reopened_by uuid REFERENCES auth.users(id), reopen_reason text,
 UNIQUE(organization_id,week_start,revision)
);
CREATE UNIQUE INDEX weekly_period_lock_active ON public.weekly_period_locks(organization_id,week_start) WHERE superseded_at IS NULL;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['weekly_item_approvals','weekly_shift_resolutions','weekly_employee_locks','weekly_period_locks'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
  EXECUTE format('GRANT ALL ON public.%I TO service_role',t);
  EXECUTE format('CREATE POLICY "Protected weekly review service" ON public.%I TO authenticated USING(false) WITH CHECK(false)',t);
 END LOOP;
END $$;

CREATE FUNCTION public.review_week(p_at timestamptz) RETURNS date LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
 SELECT date_trunc('week',p_at AT TIME ZONE 'Europe/Oslo')::date;
$$;
CREATE FUNCTION public.review_item_fingerprint(p_item jsonb) RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
 SELECT md5((p_item - ARRAY['approved','fingerprint','approved_at','approved_by'])::text);
$$;
CREATE FUNCTION public.weekly_premium_hours(p_start timestamptz,p_end timestamptz) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
 WITH dates AS (SELECT d::date AS d FROM generate_series((p_start AT TIME ZONE 'Europe/Oslo')::date::timestamp,
   (p_end AT TIME ZONE 'Europe/Oslo')::date::timestamp,interval '1 day') d WHERE p_end>p_start),
 windows AS (
 SELECT 'night' AS category,d::timestamp AT TIME ZONE 'Europe/Oslo' AS a,(d+time '06:00') AT TIME ZONE 'Europe/Oslo' AS b FROM dates
 UNION ALL SELECT 'evening',(d+time '21:00') AT TIME ZONE 'Europe/Oslo',(d+1)::timestamp AT TIME ZONE 'Europe/Oslo' FROM dates WHERE extract(isodow FROM d) BETWEEN 1 AND 5
 UNION ALL SELECT 'weekend',(d+time '18:00') AT TIME ZONE 'Europe/Oslo',(d+1)::timestamp AT TIME ZONE 'Europe/Oslo' FROM dates WHERE extract(isodow FROM d)=6
 UNION ALL SELECT 'weekend',(d+time '06:00') AT TIME ZONE 'Europe/Oslo',(d+1)::timestamp AT TIME ZONE 'Europe/Oslo' FROM dates WHERE extract(isodow FROM d)=7),
 sums AS (SELECT category,round(sum(greatest(0,extract(epoch FROM least(p_end,b)-greatest(p_start,a)))/3600),4) AS h FROM windows GROUP BY category)
 SELECT jsonb_build_object('evening',coalesce((SELECT h FROM sums WHERE category='evening'),0),'night',coalesce((SELECT h FROM sums WHERE category='night'),0),'weekend',coalesce((SELECT h FROM sums WHERE category='weekend'),0));
$$;

CREATE FUNCTION public.weekly_employee_data(p_org uuid,p_emp uuid,p_week date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE result jsonb; entries jsonb; adjustments jsonb; shifts jsonb; employee jsonb; rates jsonb; summary jsonb;
 work_h numeric; sick_h numeric; evening_h numeric; night_h numeric; weekend_h numeric; o40 numeric; o100 numeric;
 rate numeric; base_cost numeric; extra_cost numeric; missing_rate boolean; settings_missing boolean;
BEGIN
 SELECT jsonb_build_object('id',e.id,'employee_number',e.employee_number,'full_name',e.full_name,'active',e.active,
   'salary_type',d.salary_type,'salary_rate',d.salary_rate) INTO employee
 FROM public.employees e LEFT JOIN public.employee_private_details d ON d.employee_id=e.id AND d.organization_id=e.organization_id
 WHERE e.id=p_emp AND e.organization_id=p_org;
 IF employee IS NULL THEN RAISE EXCEPTION 'Ansatt finnes ikke.'; END IF;
 SELECT coalesce(jsonb_agg(x.item||jsonb_build_object('fingerprint',public.review_item_fingerprint(x.item),
  'approved',a.fingerprint=public.review_item_fingerprint(x.item),'approved_at',a.approved_at) ORDER BY x.started_at,x.id),'[]') INTO entries
 FROM (SELECT t.id,t.started_at,jsonb_build_object('id',t.id,'reference_no',t.reference_no,'kind',t.kind,'started_at',t.started_at,'ended_at',t.ended_at,
  'work_date',(t.started_at AT TIME ZONE 'Europe/Oslo')::date,'hours',CASE WHEN t.ended_at IS NULL THEN 0 ELSE extract(epoch FROM t.ended_at-t.started_at)/3600 END,
  'source',t.source,'note',t.note,'auto_clocked_out',t.auto_clocked_out,'scheduled_shift_id',t.scheduled_shift_id,
  'premium_hours',CASE WHEN t.kind='work' THEN public.weekly_premium_hours(t.started_at,t.ended_at) ELSE '{"evening":0,"night":0,"weekend":0}'::jsonb END) AS item
 FROM public.time_entries t WHERE t.organization_id=p_org AND t.employee_id=p_emp
 AND t.started_at>=p_week::timestamp AT TIME ZONE 'Europe/Oslo' AND t.started_at<(p_week+7)::timestamp AT TIME ZONE 'Europe/Oslo') x
 LEFT JOIN public.weekly_item_approvals a ON a.item_type='entry' AND a.item_id=x.id AND a.organization_id=p_org;
 SELECT coalesce(jsonb_agg(x.item||jsonb_build_object('fingerprint',public.review_item_fingerprint(x.item),
  'approved',a.fingerprint=public.review_item_fingerprint(x.item),'approved_at',a.approved_at) ORDER BY x.work_date,x.id),'[]') INTO adjustments
 FROM (SELECT t.id,t.work_date,jsonb_build_object('id',t.id,'work_date',t.work_date,'category',t.category,'hours',t.hours,'note',t.note) AS item
 FROM public.payroll_adjustments t WHERE t.organization_id=p_org AND t.employee_id=p_emp AND t.work_date>=p_week AND t.work_date<p_week+7) x
 LEFT JOIN public.weekly_item_approvals a ON a.item_type='adjustment' AND a.item_id=x.id AND a.organization_id=p_org;
 WITH planned AS (
 SELECT s||jsonb_build_object('shift_key',coalesce(s->>'id',md5(s::text)), 'fingerprint',md5(s::text)) AS item,
  ((s->>'work_date')::date+(s->>'start_time')::time) AT TIME ZONE 'Europe/Oslo' AS a,
  ((s->>'work_date')::date+CASE WHEN (s->>'end_time')::time<=(s->>'start_time')::time THEN 1 ELSE 0 END+(s->>'end_time')::time) AT TIME ZONE 'Europe/Oslo' AS b
 FROM public.shift_schedules ss CROSS JOIN LATERAL jsonb_array_elements(ss.published_snapshot) s
 WHERE ss.organization_id=p_org AND ss.week_start=p_week AND ss.status='published' AND s->>'employee_id'=p_emp::text),
 matched AS (
 SELECT t.id,(SELECT p.item->>'shift_key' FROM planned p WHERE (t.scheduled_shift_id::text=p.item->>'id'
 OR (t.started_at<p.b AND coalesce(t.ended_at,p.b)>p.a AND abs(extract(epoch FROM t.started_at-p.a))<=43200))
 ORDER BY (t.scheduled_shift_id::text=p.item->>'id') DESC NULLS LAST,abs(extract(epoch FROM t.started_at-p.a)) LIMIT 1) AS shift_key
 FROM public.time_entries t WHERE t.organization_id=p_org AND t.employee_id=p_emp
 AND t.started_at>=p_week::timestamp AT TIME ZONE 'Europe/Oslo' AND t.started_at<(p_week+7)::timestamp AT TIME ZONE 'Europe/Oslo')
 SELECT coalesce(jsonb_agg(p.item||jsonb_build_object('matched',EXISTS(SELECT 1 FROM matched m WHERE m.shift_key=p.item->>'shift_key'),
 'resolved',r.fingerprint=p.item->>'fingerprint','reason',r.reason) ORDER BY p.a,p.item->>'shift_key'),'[]') INTO shifts
 FROM planned p LEFT JOIN public.weekly_shift_resolutions r ON r.organization_id=p_org AND r.week_start=p_week AND r.shift_key=p.item->>'shift_key';
 SELECT coalesce(jsonb_object_agg(category,jsonb_build_object('code',payroll_code,'label',label,'hourly_rate',hourly_rate)),'{}') INTO rates
 FROM public.payroll_settings WHERE organization_id=p_org;
 SELECT coalesce(sum((x->>'hours')::numeric) FILTER(WHERE x->>'kind'='work'),0),coalesce(sum((x->>'hours')::numeric) FILTER(WHERE x->>'kind'='sick_pay'),0),
 coalesce(sum((x->'premium_hours'->>'evening')::numeric),0),coalesce(sum((x->'premium_hours'->>'night')::numeric),0),coalesce(sum((x->'premium_hours'->>'weekend')::numeric),0)
 INTO work_h,sick_h,evening_h,night_h,weekend_h FROM jsonb_array_elements(entries) x;
 SELECT sick_h+coalesce(sum((x->>'hours')::numeric) FILTER(WHERE x->>'category'='sick_pay'),0),
 coalesce(sum((x->>'hours')::numeric) FILTER(WHERE x->>'category'='overtime_40'),0),coalesce(sum((x->>'hours')::numeric) FILTER(WHERE x->>'category'='overtime_100'),0)
 INTO sick_h,o40,o100 FROM jsonb_array_elements(adjustments) x;
 rate:=CASE WHEN employee->>'salary_type'='hourly' THEN (employee->>'salary_rate')::numeric ELSE NULL END;
 missing_rate:=(work_h+sick_h+o40+o100)>0 AND rate IS NULL;
 settings_missing:=(evening_h>0 AND rates->'evening'->>'hourly_rate' IS NULL) OR (night_h>0 AND rates->'night'->>'hourly_rate' IS NULL) OR (weekend_h>0 AND rates->'weekend'->>'hourly_rate' IS NULL);
 base_cost:=round((work_h+sick_h)*coalesce(rate,0),2);
 extra_cost:=round(evening_h*coalesce((rates->'evening'->>'hourly_rate')::numeric,0)+night_h*coalesce((rates->'night'->>'hourly_rate')::numeric,0)
 +weekend_h*coalesce((rates->'weekend'->>'hourly_rate')::numeric,0)+(o40*.4+o100)*coalesce(rate,0),2);
 summary:=jsonb_build_object('work_hours',work_h,'sick_hours',sick_h,'evening_hours',evening_h,'night_hours',night_h,'weekend_hours',weekend_h,
  'overtime_40_hours',o40,'overtime_100_hours',o100,'hourly_rate',rate,'base_cost',base_cost,'premium_cost',extra_cost,'total_cost',base_cost+extra_cost,
  'cost_incomplete',missing_rate OR settings_missing,'payroll_codes',rates);
 result:=jsonb_build_object('employee',employee,'entries',entries,'adjustments',adjustments,'shifts',shifts,'summary',summary,
  'unapproved',(SELECT count(*) FROM (SELECT x FROM jsonb_array_elements(entries) x UNION ALL SELECT x FROM jsonb_array_elements(adjustments) x) q WHERE NOT coalesce((x->>'approved')::boolean,false)),
  'open_entries',(SELECT count(*) FROM jsonb_array_elements(entries) x WHERE x->>'ended_at' IS NULL),
  'missing_shifts',(SELECT count(*) FROM jsonb_array_elements(shifts) x WHERE NOT coalesce((x->>'matched')::boolean,false) AND NOT coalesce((x->>'resolved')::boolean,false)));
 RETURN result||jsonb_build_object('fingerprint',md5(result::text));
END $$;

CREATE FUNCTION public.weekly_review_state(p_org uuid,p_week date) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE people jsonb; period public.weekly_period_locks%ROWTYPE; result jsonb;
BEGIN
 SELECT * INTO period FROM public.weekly_period_locks WHERE organization_id=p_org AND week_start=p_week AND superseded_at IS NULL;
 WITH relevant AS (
 SELECT employee_id FROM public.time_entries WHERE organization_id=p_org AND started_at>=p_week::timestamp AT TIME ZONE 'Europe/Oslo' AND started_at<(p_week+7)::timestamp AT TIME ZONE 'Europe/Oslo'
 UNION SELECT employee_id FROM public.payroll_adjustments WHERE organization_id=p_org AND work_date>=p_week AND work_date<p_week+7
 UNION SELECT (s->>'employee_id')::uuid FROM public.shift_schedules ss CROSS JOIN LATERAL jsonb_array_elements(ss.published_snapshot) s WHERE ss.organization_id=p_org AND ss.week_start=p_week AND ss.status='published'
 UNION SELECT employee_id FROM public.weekly_employee_locks WHERE organization_id=p_org AND week_start=p_week AND superseded_at IS NULL)
 SELECT coalesce(jsonb_agg(coalesce(l.snapshot,public.weekly_employee_data(p_org,e.id,p_week))||jsonb_build_object('locked',l.id IS NOT NULL,'lock_id',l.id,'locked_at',l.locked_at,'revision',l.revision) ORDER BY e.full_name,e.id),'[]')
 INTO people FROM relevant r JOIN public.employees e ON e.id=r.employee_id AND e.organization_id=p_org
 LEFT JOIN public.weekly_employee_locks l ON l.organization_id=p_org AND l.employee_id=e.id AND l.week_start=p_week AND l.superseded_at IS NULL;
 result:=jsonb_build_object('week_start',p_week,'week_end',p_week+6,'closes_after',(p_week+7+time '08:00') AT TIME ZONE 'Europe/Oslo',
 'can_lock',now()>=(p_week+7+time '08:00') AT TIME ZONE 'Europe/Oslo','employees',people,'locked',period.id IS NOT NULL,'lock_id',period.id,'revision',period.revision,'locked_at',period.locked_at,
 'revisions',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'revision',revision,'locked_at',locked_at,'superseded_at',superseded_at,'reopen_reason',reopen_reason) ORDER BY revision DESC) FROM public.weekly_period_locks WHERE organization_id=p_org AND week_start=p_week),'[]'));
 RETURN result||jsonb_build_object('fingerprint',md5(people::text));
END $$;

-- Every writer (clock, admin, absence and roster backfill) must respect locked weeks and months.
CREATE FUNCTION public.guard_weekly_payroll_changes() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE row_data jsonb; w date; d date; emp uuid; org uuid; item text;
BEGIN
 FOREACH row_data IN ARRAY ARRAY[CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END] LOOP
  IF row_data IS NULL THEN CONTINUE; END IF;
  org:=(row_data->>'organization_id')::uuid; emp:=(row_data->>'employee_id')::uuid;
  d:=CASE WHEN TG_TABLE_NAME='time_entries' THEN ((row_data->>'started_at')::timestamptz AT TIME ZONE 'Europe/Oslo')::date ELSE (row_data->>'work_date')::date END;
  w:=date_trunc('week',d::timestamp)::date;
  IF EXISTS(SELECT 1 FROM public.weekly_period_locks WHERE organization_id=org AND week_start=w AND superseded_at IS NULL)
   OR EXISTS(SELECT 1 FROM public.weekly_employee_locks WHERE organization_id=org AND employee_id=emp AND week_start=w AND superseded_at IS NULL)
   THEN RAISE EXCEPTION 'Uken er låst. Gjenåpne uken i Ukesluttkontroll før registreringen endres.'; END IF;
  IF EXISTS(SELECT 1 FROM public.month_locks WHERE organization_id=org AND month_start=date_trunc('month',d)::date AND superseded_at IS NULL)
   OR EXISTS(SELECT 1 FROM public.month_approvals WHERE organization_id=org AND employee_id=emp AND month_start=date_trunc('month',d)::date AND status='locked')
   THEN RAISE EXCEPTION 'Måneden er låst og kan ikke endres.'; END IF;
  UPDATE public.month_approvals SET status='open',approved_by=NULL,approved_at=NULL WHERE organization_id=org AND employee_id=emp AND month_start=date_trunc('month',d)::date AND status='approved';
 END LOOP;
 item:=CASE WHEN TG_TABLE_NAME='time_entries' THEN 'entry' ELSE 'adjustment' END;
 DELETE FROM public.weekly_item_approvals WHERE item_type=item AND item_id=coalesce(NEW.id,OLD.id);
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER aa_weekly_guard BEFORE INSERT OR UPDATE OR DELETE ON public.time_entries FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_payroll_changes();
CREATE TRIGGER aa_weekly_guard BEFORE INSERT OR UPDATE OR DELETE ON public.payroll_adjustments FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_payroll_changes();

CREATE FUNCTION public.guard_weekly_roster_changes() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE row_data jsonb;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.published_snapshot,NEW.status,NEW.week_start,NEW.organization_id) IS NOT DISTINCT FROM (OLD.published_snapshot,OLD.status,OLD.week_start,OLD.organization_id) THEN RETURN NEW; END IF;
 FOREACH row_data IN ARRAY ARRAY[CASE WHEN TG_OP<>'INSERT' THEN to_jsonb(OLD) END,CASE WHEN TG_OP<>'DELETE' THEN to_jsonb(NEW) END] LOOP
  IF row_data IS NULL THEN CONTINUE; END IF;
  IF EXISTS(SELECT 1 FROM public.weekly_employee_locks WHERE organization_id=(row_data->>'organization_id')::uuid AND week_start=(row_data->>'week_start')::date AND superseded_at IS NULL)
   OR EXISTS(SELECT 1 FROM public.weekly_period_locks WHERE organization_id=(row_data->>'organization_id')::uuid AND week_start=(row_data->>'week_start')::date AND superseded_at IS NULL)
   THEN RAISE EXCEPTION 'Uken er låst i Ukesluttkontroll. Gjenåpne før publisert vaktliste endres.'; END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER weekly_roster_guard BEFORE INSERT OR UPDATE OR DELETE ON public.shift_schedules FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_roster_changes();

CREATE FUNCTION public.weekly_review(p_org uuid,p_actor uuid,p_week date,p_action text,p_body jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE state jsonb; person jsonb; emp uuid; item jsonb; target jsonb; items jsonb; approved boolean;
 r integer; lock_id uuid; reason text; w public.weekly_period_locks%ROWTYPE; before_entry public.time_entries%ROWTYPE; start_at timestamptz; end_at timestamptz;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.employees WHERE organization_id=p_org AND auth_user_id=p_actor AND role='admin' AND active) THEN RAISE EXCEPTION 'Kun administrator har tilgang.'; END IF;
 IF p_week IS NULL OR extract(isodow FROM p_week)<>1 OR p_week<date '2000-01-01' OR p_week>date '2100-01-01' THEN RAISE EXCEPTION 'Velg en gyldig uke.'; END IF;
 IF p_action='report' THEN
  SELECT * INTO w FROM public.weekly_period_locks WHERE organization_id=p_org AND week_start=p_week
   AND (CASE WHEN p_body->>'report_id' IS NOT NULL THEN id=(p_body->>'report_id')::uuid ELSE superseded_at IS NULL END) ORDER BY revision DESC LIMIT 1;
  IF w.id IS NULL THEN RAISE EXCEPTION 'Lås hele uken før ukerapporten hentes.'; END IF;
  RETURN jsonb_build_object('id',w.id,'report',w.report,'revision',w.revision,'locked_at',w.locked_at,'superseded_at',w.superseded_at);
 END IF;
 IF p_action<>'load' THEN
  -- A short transaction blocks concurrent inserts as well as edits, so no shift slips through a lock.
  LOCK TABLE public.time_entries,public.payroll_adjustments,public.shift_schedules,public.weekly_item_approvals,public.weekly_shift_resolutions,public.weekly_employee_locks,public.weekly_period_locks IN SHARE ROW EXCLUSIVE MODE;
 END IF;
 state:=public.weekly_review_state(p_org,p_week);
 IF p_action='load' THEN RETURN state; END IF;
 IF p_action NOT IN ('approve','resolve_shift','correct','lock_employee','lock_week','reopen_employee','reopen_week') THEN RAISE EXCEPTION 'Ukjent handling.'; END IF;
 IF p_body->>'expected' IS DISTINCT FROM state->>'fingerprint' THEN RAISE EXCEPTION 'Grunnlaget er endret. Oppdater uken og kontroller på nytt.'; END IF;
 emp:=nullif(p_body->>'employee_id','')::uuid;
 SELECT x INTO person FROM jsonb_array_elements(state->'employees') x WHERE x->'employee'->>'id'=emp::text;
 IF p_action NOT IN ('lock_week','reopen_week') AND person IS NULL THEN RAISE EXCEPTION 'Ansatt finnes ikke i denne uken.'; END IF;
 IF p_action IN ('reopen_employee','reopen_week') THEN
  reason:=trim(coalesce(p_body->>'reason',''));
  IF length(reason) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Skriv en begrunnelse på 3–1000 tegn.'; END IF;
  IF EXISTS(SELECT 1 FROM public.month_locks WHERE organization_id=p_org AND superseded_at IS NULL AND month_start BETWEEN date_trunc('month',p_week)::date AND date_trunc('month',p_week+7)::date)
   THEN RAISE EXCEPTION 'Uken berører en låst regnskapsmåned og kan ikke gjenåpnes.'; END IF;
  UPDATE public.weekly_period_locks SET superseded_at=now(),reopened_by=p_actor,reopen_reason=reason WHERE organization_id=p_org AND week_start=p_week AND superseded_at IS NULL;
  UPDATE public.weekly_employee_locks SET superseded_at=now(),reopened_by=p_actor,reopen_reason=reason WHERE organization_id=p_org AND week_start=p_week AND superseded_at IS NULL AND (p_action='reopen_week' OR employee_id=emp);
  DELETE FROM public.weekly_item_approvals WHERE organization_id=p_org AND week_start=p_week AND (p_action='reopen_week' OR employee_id=emp);
  DELETE FROM public.weekly_shift_resolutions WHERE organization_id=p_org AND week_start=p_week AND (p_action='reopen_week' OR employee_id=emp);
 ELSE
  IF (state->>'locked')::boolean OR coalesce((person->>'locked')::boolean,false) THEN RAISE EXCEPTION 'Uken er låst. Gjenåpne før du gjør endringer.'; END IF;
  IF p_action='approve' THEN
   approved:=coalesce((p_body->>'approved')::boolean,true);items:=p_body->'items';
   IF items IS NULL OR jsonb_typeof(items)<>'array' OR jsonb_array_length(items) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Velg registreringer.'; END IF;
   FOR item IN SELECT x FROM jsonb_array_elements(items) x LOOP
    SELECT x INTO target FROM jsonb_array_elements(CASE WHEN item->>'type'='entry' THEN person->'entries' WHEN item->>'type'='adjustment' THEN person->'adjustments' ELSE '[]'::jsonb END) x WHERE x->>'id'=item->>'id';
    IF target IS NULL OR (item->>'type'='entry' AND (target->>'ended_at' IS NULL OR (target->>'ended_at')::timestamptz>now() OR (target->>'hours')::numeric<=0)) THEN RAISE EXCEPTION 'Bare avsluttede, gyldige registreringer kan godkjennes.'; END IF;
    IF approved THEN INSERT INTO public.weekly_item_approvals(organization_id,employee_id,week_start,item_type,item_id,fingerprint,approved_by)
     VALUES(p_org,emp,p_week,item->>'type',(item->>'id')::uuid,target->>'fingerprint',p_actor)
     ON CONFLICT(item_type,item_id) DO UPDATE SET fingerprint=excluded.fingerprint,approved_by=excluded.approved_by,approved_at=now();
    ELSE DELETE FROM public.weekly_item_approvals WHERE item_type=item->>'type' AND item_id=(item->>'id')::uuid AND organization_id=p_org; END IF;
   END LOOP;
  ELSIF p_action='resolve_shift' THEN
   reason:=trim(coalesce(p_body->>'reason',''));IF length(reason) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Forklar hvorfor vakten mangler stempling.'; END IF;
   SELECT x INTO target FROM jsonb_array_elements(person->'shifts') x WHERE x->>'shift_key'=p_body->>'shift_key';
   IF target IS NULL THEN RAISE EXCEPTION 'Vakten finnes ikke.'; END IF;
   INSERT INTO public.weekly_shift_resolutions(organization_id,employee_id,week_start,shift_key,fingerprint,reason,resolved_by)
    VALUES(p_org,emp,p_week,target->>'shift_key',target->>'fingerprint',reason,p_actor)
    ON CONFLICT(organization_id,week_start,shift_key) DO UPDATE SET fingerprint=excluded.fingerprint,reason=excluded.reason,resolved_by=excluded.resolved_by,resolved_at=now();
  ELSIF p_action='correct' THEN
   reason:=trim(coalesce(p_body->>'reason',''));start_at:=(p_body->>'started_at')::timestamptz;end_at:=(p_body->>'ended_at')::timestamptz;
   IF length(reason) NOT BETWEEN 3 AND 1000 OR start_at IS NULL OR end_at IS NULL OR NOT isfinite(start_at) OR NOT isfinite(end_at) OR end_at<=start_at OR end_at>now() OR end_at-start_at>interval '24 hours' OR public.review_week(start_at)<>p_week THEN RAISE EXCEPTION 'Kontroller tidene og begrunnelsen. Vakten må starte i valgt uke, være avsluttet og vare høyst 24 timer.'; END IF;
   SELECT * INTO before_entry FROM public.time_entries WHERE organization_id=p_org AND employee_id=emp AND id=(p_body->>'entry_id')::uuid AND public.review_week(started_at)=p_week;
   IF before_entry.id IS NULL THEN RAISE EXCEPTION 'Registreringen finnes ikke.'; END IF;
   IF EXISTS(SELECT 1 FROM public.time_entries WHERE organization_id=p_org AND employee_id=emp AND id<>before_entry.id AND tstzrange(started_at,ended_at,'[)')&&tstzrange(start_at,end_at,'[)')) THEN RAISE EXCEPTION 'Tidene overlapper en annen registrering.'; END IF;
   UPDATE public.time_entries SET started_at=start_at,ended_at=end_at,source='manual',note=concat_ws(E'\n',note,'Ukesluttkontroll: '||reason),updated_at=now() WHERE id=before_entry.id;
   INSERT INTO public.audit_logs(organization_id,actor_id,action,entity_type,entity_id,details) VALUES(p_org,p_actor,'correct_time_entry','time_entry',before_entry.id::text,jsonb_build_object('reason',reason,'before',jsonb_build_object('started_at',before_entry.started_at,'ended_at',before_entry.ended_at),'after',jsonb_build_object('started_at',start_at,'ended_at',end_at)));
  ELSIF p_action IN ('lock_employee','lock_week') THEN
   IF NOT (state->>'can_lock')::boolean THEN RAISE EXCEPTION 'Uken kan først låses mandag etter kl. 08.00 norsk tid.'; END IF;
   IF p_action='lock_employee' THEN
    IF (person->>'open_entries')::integer>0 OR (person->>'unapproved')::integer>0 OR (person->>'missing_shifts')::integer>0 THEN RAISE EXCEPTION 'Alle registreringer må være avsluttet og godkjent, og manglende stemplinger må avklares.'; END IF;
    SELECT coalesce(max(revision),0)+1 INTO r FROM public.weekly_employee_locks WHERE organization_id=p_org AND employee_id=emp AND week_start=p_week;
    INSERT INTO public.weekly_employee_locks(organization_id,employee_id,week_start,revision,snapshot,locked_by) VALUES(p_org,emp,p_week,r,person-ARRAY['locked','lock_id','locked_at','revision'],p_actor);
   ELSE
    IF jsonb_array_length(state->'employees')=0 THEN RAISE EXCEPTION 'Uken har ingen registreringer eller planlagte vakter.'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(state->'employees') x WHERE NOT (x->>'locked')::boolean) THEN RAISE EXCEPTION 'Uken kan ikke avsluttes. Noen ansatte har vakter eller registreringer som ikke er ferdig behandlet og låst.'; END IF;
    SELECT coalesce(max(revision),0)+1 INTO r FROM public.weekly_period_locks WHERE organization_id=p_org AND week_start=p_week;
    INSERT INTO public.weekly_period_locks(organization_id,week_start,revision,report,locked_by) VALUES(p_org,p_week,r,state,p_actor) RETURNING id INTO lock_id;
   END IF;
  END IF;
 END IF;
 INSERT INTO public.audit_logs(organization_id,actor_id,action,entity_type,entity_id,details)
 VALUES(p_org,p_actor,'weekly_'||p_action,'weekly_review',p_week::text,jsonb_build_object('employee_id',emp,'reason',p_body->>'reason','items',p_body->'items','shift_key',p_body->>'shift_key'));
 RETURN public.weekly_review_state(p_org,p_week);
END $$;

DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN
 ('review_week','review_item_fingerprint','weekly_premium_hours','weekly_employee_data','weekly_review_state','guard_weekly_payroll_changes','guard_weekly_roster_changes','weekly_review') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',f.signature);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.signature);
 END LOOP;
END $$;
