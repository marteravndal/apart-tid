CREATE TABLE public.roster_day_completion (
 organization_id uuid NOT NULL REFERENCES public.organizations(id), work_date date NOT NULL,
 fingerprint text NOT NULL, completed_by uuid NOT NULL REFERENCES auth.users(id), completed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(organization_id,work_date)
);
ALTER TABLE public.roster_day_completion ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.roster_day_completion FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.roster_day_completion TO service_role;
CREATE POLICY "Admin service only" ON public.roster_day_completion TO authenticated USING(false) WITH CHECK(false);

CREATE FUNCTION public.payroll_day_plan(p_org uuid,p_date date,p_published boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE s public.shift_schedules%ROWTYPE; shifts jsonb; v_fingerprint text; complete boolean;
BEGIN
 SELECT * INTO s FROM public.shift_schedules WHERE organization_id=p_org AND week_start=date_trunc('week',p_date)::date;
 IF s.status='inactive' OR s.id IS NULL OR (p_published AND s.status<>'published') THEN shifts:='[]';
 ELSIF p_published THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',x->>'id','employee_id',x->>'employee_id','work_date',x->>'work_date','shift_type',x->>'shift_type','start_time',left(x->>'start_time',5),'end_time',left(x->>'end_time',5)) ORDER BY x->>'id'),'[]') INTO shifts FROM jsonb_array_elements(s.published_snapshot) x WHERE x->>'work_date'=p_date::text;
 ELSE
  SELECT coalesce(jsonb_agg(jsonb_build_object('id',x.id,'employee_id',x.employee_id,'work_date',x.work_date,'shift_type',x.shift_type,'start_time',to_char(x.start_time,'HH24:MI'),'end_time',to_char(x.end_time,'HH24:MI')) ORDER BY x.id::text),'[]') INTO shifts FROM public.scheduled_shifts x WHERE x.organization_id=p_org AND x.schedule_id=s.id AND x.work_date=p_date;
 END IF;
 v_fingerprint:=md5(shifts::text);
 SELECT c.fingerprint=v_fingerprint INTO complete FROM public.roster_day_completion c WHERE organization_id=p_org AND work_date=p_date;
 RETURN jsonb_build_object('date',p_date,'shifts',shifts,'fingerprint',v_fingerprint,'complete',coalesce(complete,false),'status',coalesce(s.status,'missing'));
END $$;

CREATE FUNCTION public.payroll_dashboard(p_org uuid,p_actor uuid,p_month date,p_action text DEFAULT 'load',p_body jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE days jsonb; weeks jsonb; baseline jsonb; base_week date; base_confirmed boolean:=false; d date; plan jsonb; result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.employees WHERE organization_id=p_org AND auth_user_id=p_actor AND role='admin' AND active) THEN RAISE EXCEPTION 'Kun administrator har tilgang.'; END IF;
 IF p_month<>date_trunc('month',p_month)::date THEN RAISE EXCEPTION 'Velg en gyldig måned.'; END IF;
 IF p_action IN ('planning','complete_day') THEN
  d:=(p_body->>'date')::date;
  IF d IS NULL THEN RAISE EXCEPTION 'Dato mangler.'; END IF;
  IF p_action='complete_day' THEN
   -- Serialize with all roster writers so completion cannot acknowledge a stale plan.
   LOCK TABLE public.shift_schedules,public.scheduled_shifts IN SHARE MODE;
   plan:=public.payroll_day_plan(p_org,d,false);
   IF p_body->>'expected' IS DISTINCT FROM plan->>'fingerprint' THEN RAISE EXCEPTION 'Vaktlisten er endret. Oppdater og prøv igjen.'; END IF;
   IF coalesce((p_body->>'complete')::boolean,false) THEN
    INSERT INTO public.roster_day_completion(organization_id,work_date,fingerprint,completed_by) VALUES(p_org,d,plan->>'fingerprint',p_actor)
    ON CONFLICT(organization_id,work_date) DO UPDATE SET fingerprint=excluded.fingerprint,completed_by=excluded.completed_by,completed_at=now();
   ELSE DELETE FROM public.roster_day_completion WHERE organization_id=p_org AND work_date=d;
   END IF;
  END IF;
  SELECT jsonb_agg(public.payroll_day_plan(p_org,x::date,false) ORDER BY x) INTO days FROM generate_series(date_trunc('week',d),date_trunc('week',d)+interval '6 days',interval '1 day') x;
  RETURN jsonb_build_object('days',days);
 END IF;
 IF p_action<>'load' THEN RAISE EXCEPTION 'Ukjent handling.'; END IF;
 SELECT jsonb_agg(public.weekly_review_state(p_org,x::date) ORDER BY x) INTO weeks
 FROM generate_series(date_trunc('week',p_month),date_trunc('week',p_month+interval '1 month'-interval '1 day'),interval '7 days') x;
 SELECT jsonb_agg(public.payroll_day_plan(p_org,x::date,x::date<(now() AT TIME ZONE 'Europe/Oslo')::date) ORDER BY x) INTO days
 FROM generate_series(p_month,p_month+interval '1 month'-interval '1 day',interval '1 day') x;
 -- Prefer the latest explicitly complete published week. Before completion markers are adopted,
 -- the last published week is usable only as a clearly labelled, unconfirmed reference.
 SELECT ss.week_start,NOT EXISTS(SELECT 1 FROM generate_series(ss.week_start,ss.week_start+6,interval '1 day') x WHERE NOT (public.payroll_day_plan(p_org,x::date,true)->>'complete')::boolean)
 INTO base_week,base_confirmed FROM public.shift_schedules ss
 WHERE ss.organization_id=p_org AND ss.status='published'
 AND ss.week_start<least(public.review_week(now()),date_trunc('week',p_month+interval '1 month'-interval '1 day')::date)
 AND ss.week_start>=least(public.review_week(now()),date_trunc('week',p_month)::date)-84
 ORDER BY (NOT EXISTS(SELECT 1 FROM generate_series(ss.week_start,ss.week_start+6,interval '1 day') x WHERE NOT (public.payroll_day_plan(p_org,x::date,true)->>'complete')::boolean)) DESC,ss.week_start DESC LIMIT 1;
 IF base_week IS NOT NULL THEN
  SELECT jsonb_agg(public.payroll_day_plan(p_org,x::date,true) ORDER BY x) INTO baseline FROM generate_series(base_week,base_week+6,interval '1 day') x;
 END IF;
 SELECT jsonb_build_object('month',p_month,'now',now(),'days',days,'weeks',weeks,'baseline',baseline,'baseline_week',base_week,'baseline_confirmed',coalesce(base_confirmed,false),
 'employees',coalesce((SELECT jsonb_agg(jsonb_build_object('id',e.id,'name',e.full_name,'active',e.active,'hourly_rate',CASE WHEN p.salary_type='hourly' THEN p.salary_rate ELSE NULL END)) FROM public.employees e LEFT JOIN public.employee_private_details p ON p.employee_id=e.id AND p.organization_id=e.organization_id WHERE e.organization_id=p_org),'[]'),
 'rates',coalesce((SELECT jsonb_object_agg(category,jsonb_build_object('hourly_rate',hourly_rate)) FROM public.payroll_settings WHERE organization_id=p_org),'{}')) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.payroll_day_plan(uuid,date,boolean),public.payroll_dashboard(uuid,uuid,date,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_day_plan(uuid,date,boolean),public.payroll_dashboard(uuid,uuid,date,text,jsonb) TO service_role;
