-- All fixtures and mutations are rolled back. No real attendance is changed.
BEGIN;
DO $$
DECLARE actor uuid; org uuid; emp uuid; other_org uuid; entry uuid; ref bigint; start_at timestamptz:=clock_timestamp()-interval '1 hour'; end_at timestamptz:=clock_timestamp(); period date:=date_trunc('month',clock_timestamp() AT TIME ZONE 'Europe/Oslo')::date; result jsonb;
BEGIN
 SELECT auth_user_id,organization_id INTO actor,org FROM public.employees WHERE role='admin' AND active AND auth_user_id IS NOT NULL LIMIT 1;
 INSERT INTO public.employees(organization_id,employee_number,full_name,email) VALUES(org,'TEST-ROLLBACK','Clock register test','register-test@example.invalid') RETURNING id INTO emp;
 INSERT INTO public.organizations(name) VALUES('Clock register foreign org - rollback') RETURNING id INTO other_org;
 INSERT INTO public.time_entries(organization_id,employee_id,started_at,ended_at,source,created_by) VALUES(org,emp,start_at,end_at,'manual',actor) RETURNING id,reference_no INTO entry,ref;
 INSERT INTO public.month_approvals(organization_id,employee_id,month_start,status,approved_by,approved_at) VALUES(org,emp,period,'approved',actor,now());
 BEGIN
   PERFORM public.delete_clock_entry(other_org,actor,entry,start_at,end_at,'Test wrong organization');
   RAISE EXCEPTION 'Cross-organization deletion allowed' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE '%administrator%' THEN RAISE; END IF; END;
 BEGIN
   PERFORM public.delete_clock_entry(org,actor,entry,start_at,end_at,' ');
   RAISE EXCEPTION 'Empty reason allowed' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE '%begrunnelse%' THEN RAISE; END IF; END;
 BEGIN
   PERFORM public.delete_clock_entry(org,actor,entry,start_at,end_at-interval '1 minute','Stale confirmation');
   RAISE EXCEPTION 'Stale deletion allowed' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE '%endret%' THEN RAISE; END IF; END;
 UPDATE public.month_approvals SET status='locked' WHERE employee_id=emp;
 BEGIN
   PERFORM public.delete_clock_entry(org,actor,entry,start_at,end_at,'Locked month test');
   RAISE EXCEPTION 'Locked approval deleted' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE '%låst%' THEN RAISE; END IF; END;
 UPDATE public.month_approvals SET status='approved' WHERE employee_id=emp;
 -- A month lock alone must protect it even if the employee approval is open.
 INSERT INTO public.month_locks(organization_id,month_start,revision,locked_by) VALUES(org,period,99999,actor);
 BEGIN
   PERFORM public.delete_clock_entry(org,actor,entry,start_at,end_at,'Locked month test');
   RAISE EXCEPTION 'Locked month deleted' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE '%låst%' THEN RAISE; END IF; END;
 DELETE FROM public.month_locks WHERE organization_id=org AND month_start=period AND revision=99999;
 result:=public.delete_clock_entry(org,actor,entry,start_at,end_at,'Synthetic mistaken re-entry');
 IF result->>'ok'<>'true' OR (result->>'reference_no')::bigint<>ref THEN RAISE EXCEPTION 'Delete result mismatch'; END IF;
 IF EXISTS(SELECT 1 FROM public.time_entries WHERE id=entry) THEN RAISE EXCEPTION 'Still included in payroll'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.clock_register WHERE id=entry AND reference_no=ref AND deleted_by=actor AND deletion_reason='Synthetic mistaken re-entry') THEN RAISE EXCEPTION 'Archive missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audit_logs WHERE entity_id=entry::text AND action='delete_time_entry' AND actor_id=actor AND details->>'reason'='Synthetic mistaken re-entry') THEN RAISE EXCEPTION 'Audit missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.month_approvals WHERE employee_id=emp AND status='open' AND approved_by IS NULL) THEN RAISE EXCEPTION 'Approval not reopened'; END IF;
 IF public.clock_in_gate(emp,org,end_at+interval '1 second')->>'code'<>'cooldown' THEN RAISE EXCEPTION 'Deleting removed cooldown'; END IF;
 BEGIN
   PERFORM public.delete_clock_entry(org,actor,entry,start_at,end_at,'Duplicate request');
   RAISE EXCEPTION 'Duplicate deletion accepted' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE '%allerede slettet%' THEN RAISE; END IF; END;
 INSERT INTO public.time_entries(organization_id,employee_id,started_at,source,created_by) VALUES(org,emp,now(),'manual',actor) RETURNING id INTO entry;
 BEGIN
   PERFORM public.delete_clock_entry(org,actor,entry,now(),now(),'Open attendance');
   RAISE EXCEPTION 'Open entry deleted' USING ERRCODE='XX000';
 EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM NOT LIKE '%Stemple%' THEN RAISE; END IF; END;
 IF has_table_privilege('authenticated','public.clock_register','SELECT') OR has_table_privilege('anon','public.deleted_time_entries','SELECT') OR has_function_privilege('authenticated','public.delete_clock_entry(uuid,uuid,uuid,timestamptz,timestamptz,text)','EXECUTE') THEN RAISE EXCEPTION 'Public archive access'; END IF;
END $$;
ROLLBACK;
