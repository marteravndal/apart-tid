BEGIN;
DO $$
DECLARE actor uuid := (SELECT auth_user_id FROM public.employees WHERE role='admin' AND active AND auth_user_id IS NOT NULL LIMIT 1); org uuid; emp uuid; schedule uuid; entry uuid; gate jsonb;
BEGIN
 INSERT INTO public.organizations(name) VALUES ('Clock guard test - rolled back') RETURNING id INTO org;
 INSERT INTO public.employees(organization_id,employee_number,full_name,email) VALUES(org,'TEST','Clock guard test','clock-guard-test@example.invalid') RETURNING id INTO emp;
 INSERT INTO public.shift_schedules(organization_id,week_start,status,published_snapshot) VALUES(org,'2026-10-05','published',jsonb_build_array(jsonb_build_object('employee_id',emp,'work_date','2026-10-06','start_time','16:00','end_time','23:00'),jsonb_build_object('employee_id',emp,'work_date','2026-10-11','start_time','23:00','end_time','07:00'))) RETURNING id INTO schedule;
 gate:=public.clock_in_gate(emp,org,'2026-10-06 14:59+02');
 IF gate->>'code'<>'no_shift' THEN RAISE EXCEPTION 'Too early allowed'; END IF;
 IF NOT (public.clock_in_gate(emp,org,'2026-10-06 15:00+02')->>'allowed')::boolean THEN RAISE EXCEPTION 'One hour before shift rejected'; END IF;
 IF (public.clock_in_gate(emp,org,'2026-10-06 23:00+02')->>'allowed')::boolean THEN RAISE EXCEPTION 'Ended shift allowed'; END IF;
 IF NOT (public.clock_in_gate(emp,org,'2026-10-12 06:59+02')->>'allowed')::boolean THEN RAISE EXCEPTION 'Sunday night into Monday rejected'; END IF;
 UPDATE public.shift_schedules SET status='draft' WHERE id=schedule;
 IF (public.clock_in_gate(emp,org,'2026-10-06 16:00+02')->>'allowed')::boolean THEN RAISE EXCEPTION 'Draft shift allowed'; END IF;
 UPDATE public.shift_schedules SET status='published' WHERE id=schedule;
 INSERT INTO public.time_entries(organization_id,employee_id,started_at,ended_at,source,created_by) VALUES(org,emp,'2026-10-06 16:00+02','2026-10-06 17:00+02','manual',actor) RETURNING id INTO entry;
 IF public.clock_in_gate(emp,org,'2026-10-06 17:01:59+02')->>'code'<>'cooldown' THEN RAISE EXCEPTION 'Cooldown not enforced'; END IF;
 IF NOT (public.clock_in_gate(emp,org,'2026-10-06 17:02:00+02')->>'allowed')::boolean THEN RAISE EXCEPTION 'Exactly two minutes rejected'; END IF;
 -- Fall DST change: local night interval must end at 07:00 CET, not UTC+2.
 UPDATE public.shift_schedules SET week_start='2026-10-19',published_snapshot=jsonb_build_array(jsonb_build_object('employee_id',emp,'work_date','2026-10-24','start_time','23:00','end_time','07:00')) WHERE id=schedule;
 gate:=public.clock_in_gate(emp,org,'2026-10-25 06:30+01');
 IF NOT (gate->>'allowed')::boolean OR (gate->>'shift_end')::timestamptz<>'2026-10-25 07:00+01'::timestamptz THEN RAISE EXCEPTION 'DST night failed'; END IF;
 -- Direct writes must also respect the gate (no client bypass).
 UPDATE public.time_entries SET started_at=clock_timestamp()-interval '1 hour',ended_at=clock_timestamp() WHERE id=entry;
 BEGIN
   INSERT INTO public.time_entries(organization_id,employee_id,started_at,source,created_by) VALUES(org,emp,clock_timestamp(),'location',actor);
   RAISE EXCEPTION 'Expected cooldown trigger rejection' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
   IF SQLERRM NOT LIKE '%to minutter%' THEN RAISE; END IF;
 END;
 -- Manual ADMIN path is the explicit exception.
 INSERT INTO public.time_entries(organization_id,employee_id,started_at,source,created_by) VALUES(org,emp,clock_timestamp(),'manual',actor);
 IF has_function_privilege('authenticated','public.clock_in_gate(uuid,uuid,timestamptz)','EXECUTE') OR has_function_privilege('anon','public.clock_in_gate(uuid,uuid,timestamptz)','EXECUTE') THEN RAISE EXCEPTION 'Gate exposed publicly'; END IF;
END $$;
ROLLBACK;
