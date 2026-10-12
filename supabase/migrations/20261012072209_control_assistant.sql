CREATE TABLE public.control_alerts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid NOT NULL REFERENCES public.organizations(id),
 alert_key text NOT NULL,category text NOT NULL,severity integer NOT NULL CHECK(severity BETWEEN 1 AND 3),
 data jsonb NOT NULL,fingerprint text NOT NULL,status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','handled','cleared')),
 first_seen timestamptz NOT NULL DEFAULT now(),last_seen timestamptz NOT NULL DEFAULT now(),
 handled_at timestamptz,handled_by uuid REFERENCES auth.users(id),comment text,
 UNIQUE(organization_id,alert_key)
);
CREATE INDEX control_alerts_org_status_idx ON public.control_alerts(organization_id,status,severity);
ALTER TABLE public.control_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.control_alerts FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.control_alerts TO service_role;
CREATE POLICY "ADMIN service only" ON public.control_alerts TO authenticated USING(false) WITH CHECK(false);
CREATE TABLE public.control_scan_health (
 organization_id uuid PRIMARY KEY REFERENCES public.organizations(id),background_at timestamptz,
 clock_job_ok boolean NOT NULL DEFAULT false,last_clock_success timestamptz
);
ALTER TABLE public.control_scan_health ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.control_scan_health FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.control_scan_health TO service_role;
CREATE POLICY "ADMIN service only" ON public.control_scan_health TO authenticated USING(false);

-- Only dates, working times and absence periods are read. No health notes, bank or identity details.
CREATE FUNCTION public.control_candidates(p_org uuid)
RETURNS TABLE(alert_key text,category text,severity integer,data jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public,pg_temp AS $$
WITH bounds AS (SELECT public.review_week(now())-7 AS lo,public.review_week(now())+14 AS hi),
people AS (SELECT id,full_name FROM public.employees WHERE organization_id=p_org),
raw_published AS (
 SELECT x,ss.id AS schedule_id,ss.week_start FROM public.shift_schedules ss CROSS JOIN LATERAL jsonb_array_elements(ss.published_snapshot) x,bounds b
 WHERE ss.organization_id=p_org AND ss.status='published' AND ss.week_start>=b.lo-7 AND ss.week_start<b.hi
),
published AS (
 SELECT coalesce(x->>'id',md5(x::text)) AS id,md5(x::text) AS fingerprint,(x->>'employee_id')::uuid AS employee_id,(x->>'work_date')::date AS work_date,week_start,
 ((x->>'work_date')::date+(x->>'start_time')::time) AT TIME ZONE 'Europe/Oslo' AS starts,
 (((x->>'work_date')::date+CASE WHEN (x->>'end_time')::time<=(x->>'start_time')::time THEN 1 ELSE 0 END)+(x->>'end_time')::time) AT TIME ZONE 'Europe/Oslo' AS ends
 FROM raw_published,bounds b WHERE (x->>'work_date')::date>=b.lo AND (x->>'work_date')::date<b.hi
),
plan AS (
 SELECT s.id::text,s.employee_id,s.work_date,ss.week_start,ss.status,
 (s.work_date+s.start_time) AT TIME ZONE 'Europe/Oslo' AS starts,
 ((s.work_date+CASE WHEN s.end_time<=s.start_time THEN 1 ELSE 0 END)+s.end_time) AT TIME ZONE 'Europe/Oslo' AS ends
 FROM public.scheduled_shifts s JOIN public.shift_schedules ss ON ss.id=s.schedule_id AND ss.organization_id=s.organization_id,bounds b
 WHERE s.organization_id=p_org AND ss.status<>'inactive' AND s.work_date>=b.lo AND s.work_date<b.hi
),
absence AS (
 SELECT id,employee_id,start_date,end_date,'Registrert sykefravær'::text AS label FROM public.sick_leave_requests
 WHERE organization_id=p_org AND status<>'rejected' AND cancelled_at IS NULL
 UNION ALL SELECT id,employee_id,start_date,end_date,CASE WHEN request_type='leave' THEN 'Godkjent permisjon' ELSE 'Godkjent ferie' END
 FROM public.vacation_requests WHERE organization_id=p_org AND status='approved'
),
entries AS (
 SELECT t.* FROM public.time_entries t,bounds b WHERE t.organization_id=p_org AND (t.ended_at IS NULL OR (t.started_at>=b.lo::timestamp AT TIME ZONE 'Europe/Oslo' AND t.started_at<b.hi::timestamp AT TIME ZONE 'Europe/Oslo'))
),
matched AS (
 SELECT t.*,p.id AS shift_id,p.starts AS planned_start,p.ends AS planned_end FROM entries t
 LEFT JOIN LATERAL (SELECT s.* FROM published s WHERE s.employee_id=t.employee_id AND (
  s.id=t.scheduled_shift_id::text OR (t.started_at<s.ends AND coalesce(t.ended_at,now())>s.starts AND abs(extract(epoch FROM t.started_at-s.starts))<=43200))
 ORDER BY (s.id=t.scheduled_shift_id::text) DESC NULLS LAST,abs(extract(epoch FROM t.started_at-s.starts)),s.id LIMIT 1) p ON true
),
unreviewed AS (
 SELECT m.* FROM matched m WHERE NOT EXISTS(SELECT 1 FROM public.weekly_item_approvals a WHERE a.organization_id=p_org AND a.item_type='entry' AND a.item_id=m.id)
 AND NOT EXISTS(SELECT 1 FROM public.weekly_employee_locks l WHERE l.organization_id=p_org AND l.employee_id=m.employee_id AND l.week_start=public.review_week(m.started_at) AND l.superseded_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM public.month_approvals a WHERE a.organization_id=p_org AND a.employee_id=m.employee_id AND a.month_start=date_trunc('month',m.started_at AT TIME ZONE 'Europe/Oslo')::date AND a.status IN ('approved','locked'))
),
weekly AS (SELECT p.employee_id,p.week_start,round(sum(extract(epoch FROM ends-starts)/3600),2) AS hours FROM plan p GROUP BY p.employee_id,p.week_start),
candidates AS (
 SELECT 'auto:'||t.id AS key,'clock'::text AS category,1 AS severity,
 jsonb_build_object('rule','auto_clock','title','Automatisk utstemplet','detail','Kontroller faktisk sluttid før godkjenning.','employee_id',t.employee_id,'date',(t.started_at AT TIME ZONE 'Europe/Oslo')::date,'target','entry','entry_id',t.id,'reference_no',t.reference_no,'started_at',t.started_at,'ended_at',t.ended_at,'planned_start',t.planned_start,'planned_end',t.planned_end) AS data
 FROM unreviewed t WHERE t.auto_clocked_out
 UNION ALL
 SELECT 'open:'||t.id,'clock',1,jsonb_build_object('rule','open_clock','title','Fortsatt innstemplet','detail',CASE WHEN t.planned_end IS NOT NULL THEN 'Minst 30 minutter etter planlagt slutt. Kontroller om den ansatte fortsatt er på jobb.' ELSE 'Innstemplet i minst 11,5 timer. Kontroller om utstempling er glemt.' END,'employee_id',t.employee_id,'date',(t.started_at AT TIME ZONE 'Europe/Oslo')::date,'target','entry','entry_id',t.id,'reference_no',t.reference_no,'started_at',t.started_at,'planned_end',t.planned_end)
 FROM matched t WHERE t.ended_at IS NULL AND (now()>=t.planned_end+interval '30 minutes' OR (t.planned_end IS NULL AND now()>=t.started_at+interval '11.5 hours'))
 UNION ALL
 SELECT 'missing:'||s.id,'clock',2,jsonb_build_object('rule','missing_clock','title','Mangler stempling til publisert vakt','detail','Vakten startet for mer enn 30 minutter siden. Kontroller oppmøte eller etterregistrering.','employee_id',s.employee_id,'date',s.work_date,'target','roster','shift_id',s.id,'planned_start',s.starts,'planned_end',s.ends)
 FROM published s WHERE s.starts+interval '30 minutes'<=now()
 AND NOT EXISTS(SELECT 1 FROM matched t WHERE t.employee_id=s.employee_id AND t.shift_id=s.id)
 AND NOT EXISTS(SELECT 1 FROM absence a WHERE a.employee_id=s.employee_id AND s.starts<(a.end_date+1)::timestamp AT TIME ZONE 'Europe/Oslo' AND s.ends>a.start_date::timestamp AT TIME ZONE 'Europe/Oslo')
 AND NOT EXISTS(SELECT 1 FROM public.weekly_shift_resolutions r WHERE r.organization_id=p_org AND r.employee_id=s.employee_id AND r.week_start=s.week_start AND r.shift_key=s.id AND r.fingerprint=s.fingerprint)
 AND NOT EXISTS(SELECT 1 FROM public.weekly_employee_locks l WHERE l.organization_id=p_org AND l.employee_id=s.employee_id AND l.week_start=s.week_start AND l.superseded_at IS NULL)
 UNION ALL
 SELECT 'deviation:'||t.id,'clock',2,jsonb_build_object('rule','time_deviation','title','Tidene avviker fra vaktlisten','detail','Minst 15 minutters avvik ved inn- eller utstempling. Kontroller om tidene er riktige.','employee_id',t.employee_id,'date',(t.started_at AT TIME ZONE 'Europe/Oslo')::date,'target','entry','entry_id',t.id,'reference_no',t.reference_no,'started_at',t.started_at,'ended_at',t.ended_at,'planned_start',t.planned_start,'planned_end',t.planned_end)
 FROM unreviewed t WHERE t.kind='work' AND NOT t.auto_clocked_out AND t.ended_at IS NOT NULL AND t.shift_id IS NOT NULL AND (abs(extract(epoch FROM t.started_at-t.planned_start))>=900 OR abs(extract(epoch FROM t.ended_at-t.planned_end))>=900)
 UNION ALL
 SELECT 'entry-overlap:'||a.id||':'||b.id,'clock',1,jsonb_build_object('rule','entry_overlap','title','Stemplinger overlapper','detail','To registreringer dekker samme tidsrom. Kontroller mulig dobbeltføring.','employee_id',a.employee_id,'date',(a.started_at AT TIME ZONE 'Europe/Oslo')::date,'target','entry','entry_id',a.id,'reference_no',a.reference_no,'other_reference_no',b.reference_no,'started_at',a.started_at,'ended_at',a.ended_at,'other_start',b.started_at,'other_end',b.ended_at)
 FROM entries a JOIN entries b ON a.employee_id=b.employee_id AND a.id<b.id AND a.started_at<coalesce(b.ended_at,now()) AND b.started_at<coalesce(a.ended_at,now())
 UNION ALL
 SELECT 'plan-overlap:'||a.id||':'||b.id,'roster',1,jsonb_build_object('rule','plan_overlap','title','Overlappende vakter','detail','Den ansatte er satt opp på to vakter samtidig i gjeldende vaktliste.','employee_id',a.employee_id,'date',a.work_date,'target','roster','planned_start',a.starts,'planned_end',a.ends,'other_start',b.starts,'other_end',b.ends)
 FROM plan a JOIN plan b ON a.employee_id=b.employee_id AND a.id<b.id AND a.starts<b.ends AND b.starts<a.ends
 UNION ALL
 SELECT 'absence:'||p.id||':'||a.id,'roster',2,jsonb_build_object('rule','absence_conflict','title','Vakt under registrert fravær','detail',a.label||'. Kontroller behov for tilpasning eller vikar.','employee_id',p.employee_id,'date',p.work_date,'target','roster','planned_start',p.starts,'planned_end',p.ends,'absence_start',a.start_date,'absence_end',a.end_date)
 FROM plan p JOIN absence a ON a.employee_id=p.employee_id AND p.starts<(a.end_date+1)::timestamp AT TIME ZONE 'Europe/Oslo' AND p.ends>a.start_date::timestamp AT TIME ZONE 'Europe/Oslo'
 UNION ALL
 SELECT 'position:'||w.employee_id||':'||w.week_start,'hours',3,jsonb_build_object('rule','position_hours','title','Planlagte timer over ukenormen','detail','Veiledende ukenorm basert på 165 timer per måned ved 100 % stilling. Uker kan variere; kontroller fordelingen over tid.','employee_id',w.employee_id,'date',w.week_start,'target','roster','hours',w.hours,'norm',round(165*12.0/52*d.position_percent/100,2),'position_percent',d.position_percent)
 FROM weekly w JOIN public.employee_private_details d ON d.employee_id=w.employee_id AND d.organization_id=p_org WHERE d.position_percent IS NOT NULL AND w.hours>165*12.0/52*d.position_percent/100+0.02
 UNION ALL
 SELECT 'mail:'||n.entry_id,'system',1,jsonb_build_object('rule','unsent_mail','title','E-postvarsel er ikke sendt','detail','Varsel om automatisk utstempling venter på sending eller krever oppfølging. Se sendestatus under Stempling.','employee_id',e.employee_id,'date',(e.started_at AT TIME ZONE 'Europe/Oslo')::date,'target','entry','entry_id',n.entry_id,'reference_no',e.reference_no,'recipients',jsonb_agg(jsonb_build_object('kind',n.recipient_kind,'needs_review',n.needs_review) ORDER BY n.recipient_kind))
 FROM public.auto_clock_notifications n JOIN public.clock_register e ON e.id=n.entry_id AND e.organization_id=n.organization_id
 WHERE n.organization_id=p_org AND n.sent_at IS NULL AND (n.needs_review OR n.created_at<now()-interval '5 minutes') GROUP BY n.entry_id,e.employee_id,e.started_at,e.reference_no
)
SELECT c.key,c.category,c.severity,c.data||jsonb_build_object('employee_name',coalesce(p.full_name,'System')) FROM candidates c LEFT JOIN people p ON p.id=(c.data->>'employee_id')::uuid;
$$;
REVOKE ALL ON FUNCTION public.control_candidates(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.control_candidates(uuid) TO service_role;

CREATE FUNCTION public.refresh_control_alerts(p_org uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE candidate record; seen text[]:='{}';
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(p_org::text,1201026));
 FOR candidate IN SELECT * FROM public.control_candidates(p_org) LOOP
  seen:=array_append(seen,candidate.alert_key);
  INSERT INTO public.control_alerts(organization_id,alert_key,category,severity,data,fingerprint)
  VALUES(p_org,candidate.alert_key,candidate.category,candidate.severity,candidate.data,md5(candidate.data::text))
  ON CONFLICT(organization_id,alert_key) DO UPDATE SET category=excluded.category,severity=excluded.severity,data=excluded.data,fingerprint=excluded.fingerprint,last_seen=now(),
   status=CASE WHEN control_alerts.fingerprint<>excluded.fingerprint OR control_alerts.status='cleared' THEN 'open' ELSE control_alerts.status END;
 END LOOP;
 UPDATE public.control_alerts SET status='cleared' WHERE organization_id=p_org AND status<>'cleared' AND NOT(alert_key=ANY(seen));
END $$;
REVOKE ALL ON FUNCTION public.refresh_control_alerts(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_control_alerts(uuid) TO service_role;

CREATE FUNCTION public.control_assistant(p_org uuid,p_actor uuid,p_action text DEFAULT 'load',p_body jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE a public.control_alerts%ROWTYPE; result jsonb; note text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.employees WHERE organization_id=p_org AND auth_user_id=p_actor AND role='admin' AND active) THEN RAISE EXCEPTION 'Kun ADMIN har tilgang.'; END IF;
 IF p_action NOT IN ('load','handle','reopen') THEN RAISE EXCEPTION 'Ukjent handling.'; END IF;
 PERFORM public.refresh_control_alerts(p_org);
 IF p_action<>'load' THEN
  SELECT * INTO a FROM public.control_alerts WHERE id=(p_body->>'id')::uuid AND organization_id=p_org FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Saken finnes ikke.'; END IF;
  IF a.status='cleared' OR a.fingerprint IS DISTINCT FROM p_body->>'expected' OR a.status IS DISTINCT FROM p_body->>'expected_status' THEN RAISE EXCEPTION 'Grunnlaget eller statusen er endret. Oppdater listen før du behandler saken.'; END IF;
  note:=trim(p_body->>'comment');
  IF note IS NULL OR length(note) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'Skriv en kommentar på 3–1000 tegn.'; END IF;
  UPDATE public.control_alerts SET status=CASE WHEN p_action='handle' THEN 'handled' ELSE 'open' END,comment=note,handled_at=now(),handled_by=p_actor WHERE id=a.id;
  INSERT INTO public.audit_logs(organization_id,actor_id,action,entity_type,entity_id,details)
  VALUES(p_org,p_actor,'control_'||p_action,'control_alert',a.id::text,jsonb_build_object('alert_key',a.alert_key,'fingerprint',a.fingerprint,'comment',note,'from_status',a.status));
 END IF;
 SELECT jsonb_build_object('checked_at',now(),'from_date',public.review_week(now())-7,'to_date',public.review_week(now())+13,
  'alerts',coalesce((SELECT jsonb_agg(x ORDER BY x.severity,x.first_seen DESC,x.id) FROM (SELECT a.*,coalesce(e.full_name,'Tidligere ADMIN') AS handled_by_name FROM public.control_alerts a LEFT JOIN public.employees e ON e.auth_user_id=a.handled_by AND e.organization_id=p_org WHERE a.organization_id=p_org AND (a.status='open' OR a.last_seen>=now()-interval '90 days') ORDER BY a.severity,a.first_seen DESC,a.id LIMIT 1000) x),'[]'),
  'total',(SELECT count(*) FROM public.control_alerts WHERE organization_id=p_org AND (status='open' OR last_seen>=now()-interval '90 days')),
  'health',(SELECT to_jsonb(h)-'organization_id' FROM public.control_scan_health h WHERE organization_id=p_org)) INTO result;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.control_assistant(uuid,uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.control_assistant(uuid,uuid,text,jsonb) TO service_role;

-- Database-only scheduler: job metadata and credentials never reach the client.
CREATE FUNCTION public.scan_control_alerts()
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE org uuid; last_clock timestamptz; clock_active boolean;
BEGIN
 SELECT j.active,max(r.end_time) FILTER(WHERE r.status='succeeded') INTO clock_active,last_clock FROM cron.job j LEFT JOIN cron.job_run_details r ON r.jobid=j.jobid WHERE j.jobname='apart-auto-clock-out' GROUP BY j.active;
 FOR org IN SELECT id FROM public.organizations LOOP
  PERFORM public.refresh_control_alerts(org);
  INSERT INTO public.control_scan_health(organization_id,background_at,clock_job_ok,last_clock_success)
  VALUES(org,now(),coalesce(clock_active AND last_clock>=now()-interval '5 minutes',false),last_clock)
  ON CONFLICT(organization_id) DO UPDATE SET background_at=excluded.background_at,clock_job_ok=excluded.clock_job_ok,last_clock_success=excluded.last_clock_success;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.scan_control_alerts() FROM PUBLIC,anon,authenticated,service_role;
SELECT cron.schedule('apart-control-assistant','*/5 * * * *','SELECT public.scan_control_alerts();');
