BEGIN;
DO $$
DECLARE actor uuid; org uuid; emp uuid; schedule uuid; shift uuid; second_shift uuid; entry uuid; expected jsonb; result jsonb; a timestamptz:='2025-06-02 23:00+02'; b timestamptz:='2025-06-03 07:00+02';
BEGIN
 SELECT auth_user_id,organization_id INTO actor,org FROM public.employees WHERE active AND role='admin' AND auth_user_id IS NOT NULL LIMIT 1;
 INSERT INTO public.employees(organization_id,employee_number,full_name,email) VALUES(org,'TEST-BACKFILL','Synthetic backfill','backfill@example.invalid') RETURNING id INTO emp;
 INSERT INTO public.shift_schedules(organization_id,week_start,status,created_by) VALUES(org,'2025-06-02','draft',actor) RETURNING id INTO schedule;
 INSERT INTO public.scheduled_shifts(schedule_id,organization_id,employee_id,work_date,shift_type,start_time,end_time,created_by) VALUES(schedule,org,emp,'2025-06-02','night','23:00','07:00',actor) RETURNING id INTO shift;
 expected:=jsonb_build_object('employee_id',emp,'work_date','2025-06-02','start_time','23:00','end_time','07:00');
 BEGIN
   PERFORM public.stamp_roster_shift(gen_random_uuid(),actor,shift,expected,a,b,'work','Wrong organization');
   RAISE EXCEPTION 'Cross org succeeded' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE '%administrator%' THEN RAISE; END IF; END;
 BEGIN
   PERFORM public.stamp_roster_shift(org,actor,shift,expected||'{"start_time":"22:00"}',a,b,'work','Stale roster');
   RAISE EXCEPTION 'Stale shift succeeded' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE '%endret%' THEN RAISE; END IF; END;
 BEGIN
   PERFORM public.stamp_roster_shift(org,actor,shift,expected,now(),now()+interval '1 hour','work','Future attendance');
   RAISE EXCEPTION 'Future succeeded' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE '%avsluttede%' THEN RAISE; END IF; END;
 INSERT INTO public.month_approvals(organization_id,employee_id,month_start,status,approved_by,approved_at) VALUES(org,emp,'2025-06-01','locked',actor,now());
 BEGIN
   PERFORM public.stamp_roster_shift(org,actor,shift,expected,a,b,'work','Locked attendance');
   RAISE EXCEPTION 'Locked succeeded' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE '%låst%' THEN RAISE; END IF; END;
 UPDATE public.month_approvals SET status='approved' WHERE employee_id=emp;
 -- An employee's own overlapping attendance must prevent a duplicate roster stamp.
 INSERT INTO public.time_entries(organization_id,employee_id,started_at,ended_at,source,created_by) VALUES(org,emp,a+interval '5 minutes',b,'manual',actor) RETURNING id INTO entry;
 BEGIN
   PERFORM public.stamp_roster_shift(org,actor,shift,expected,a,b,'work','Overlap attendance');
   RAISE EXCEPTION 'Overlap succeeded' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE '%overlapper%' THEN RAISE; END IF; END;
 DELETE FROM public.time_entries WHERE id=entry;
 result:=public.stamp_roster_shift(org,actor,shift,expected,a,b+interval '30 minutes','work','Worked half an hour longer');
 entry:=(result->'entry'->>'id')::uuid;
 IF NOT EXISTS(SELECT 1 FROM public.time_entries WHERE id=entry AND kind='work' AND scheduled_shift_id=shift AND ended_at=b+interval '30 minutes') THEN RAISE EXCEPTION 'Wrong attendance times'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.month_approvals WHERE employee_id=emp AND status='open') THEN RAISE EXCEPTION 'Approval not reopened'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audit_logs WHERE entity_id=entry::text AND actor_id=actor AND action='stamp_roster_shift' AND details->>'reason'='Worked half an hour longer') THEN RAISE EXCEPTION 'Audit missing'; END IF;
 BEGIN
   PERFORM public.stamp_roster_shift(org,actor,shift,expected,a,b,'work','Double click');
   RAISE EXCEPTION 'Duplicate succeeded' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE '%allerede%' THEN RAISE; END IF; END;
 BEGIN
   INSERT INTO public.time_entries(organization_id,employee_id,started_at,ended_at,source,created_by) VALUES(org,emp,a,b,'manual',actor);
   RAISE EXCEPTION 'Direct overlapping insert succeeded' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE '%overlapper%' THEN RAISE; END IF; END;
 -- A deleted mistake can be correctly re-recorded as sick pay, with the original audit retained.
 PERFORM public.delete_clock_entry(org,actor,entry,a,b+interval '30 minutes','Wrong kind');
 result:=public.stamp_roster_shift(org,actor,shift,expected,a,b,'sick_pay','Sick pay instead of work');
 IF NOT EXISTS(SELECT 1 FROM public.clock_register WHERE id=(result->'entry'->>'id')::uuid AND kind='sick_pay' AND ended_at=b) THEN RAISE EXCEPTION 'Sick pay kind missing'; END IF;
 INSERT INTO public.scheduled_shifts(schedule_id,organization_id,employee_id,work_date,shift_type,start_time,end_time,created_by) VALUES(schedule,org,emp,'2025-06-04','day','08:00','16:00',actor) RETURNING id INTO second_shift;
 INSERT INTO public.payroll_adjustments(organization_id,employee_id,work_date,category,hours,note,created_by) VALUES(org,emp,'2025-06-04','sick_pay',8,'Synthetic sickness',actor);
 BEGIN
   PERFORM public.stamp_roster_shift(org,actor,second_shift,jsonb_build_object('employee_id',emp,'work_date','2025-06-04','start_time','08:00','end_time','16:00'),'2025-06-04 08:00+02','2025-06-04 16:00+02','sick_pay','Duplicate sickness');
   RAISE EXCEPTION 'Duplicate sickness succeeded' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE '%allerede ført sykepenger%' THEN RAISE; END IF; END;
 IF has_function_privilege('authenticated','public.stamp_roster_shift(uuid,uuid,uuid,jsonb,timestamptz,timestamptz,text,text)','EXECUTE') THEN RAISE EXCEPTION 'Public write exposed'; END IF;
END $$;
ROLLBACK;
