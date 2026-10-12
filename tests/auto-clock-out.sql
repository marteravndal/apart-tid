-- Transactional fixtures only. This test never invokes HTTP or sends email.
BEGIN;
DO $$
DECLARE org uuid; emp uuid; actor uuid; e uuid; recent uuid; manual uuid; j public.auto_clock_notifications%ROWTYPE; result jsonb; first_lease uuid;
BEGIN
 SELECT auth_user_id INTO actor FROM public.employees WHERE role='admin' AND active AND auth_user_id IS NOT NULL LIMIT 1;
 INSERT INTO public.organizations(name) VALUES('Auto clock test - rollback') RETURNING id INTO org;
 INSERT INTO public.employees(organization_id,employee_number,full_name,email) VALUES(org,'AUTO-TEST','Test Ansatt','auto-clock@example.invalid') RETURNING id INTO emp;
 INSERT INTO public.time_entries(organization_id,employee_id,started_at,source,created_by) VALUES(org,emp,now()-interval '13 hours','manual',actor) RETURNING id INTO e;
 -- Simulate an obsolete approval. Closing must invalidate it.
 INSERT INTO public.weekly_item_approvals(organization_id,employee_id,week_start,item_type,item_id,fingerprint,approved_by)
 VALUES(org,emp,public.review_week(now()-interval '13 hours'),'entry',e,'obsolete',actor);
 result:=public.close_overdue_time_entries(emp);
 IF result->>'closed'<>'1' OR result->>'failed'<>'0' THEN RAISE EXCEPTION 'Close failed: %',result; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.time_entries WHERE id=e AND auto_clocked_out AND ended_at=started_at+interval '12 hours' AND note LIKE '%Automatisk utstemplet%') THEN RAISE EXCEPTION 'Wrong cutoff/flag'; END IF;
 IF EXISTS(SELECT 1 FROM public.weekly_item_approvals WHERE item_id=e) THEN RAISE EXCEPTION 'Approval was preserved'; END IF;
 IF (SELECT count(*) FROM public.auto_clock_notifications WHERE entry_id=e)<>2 THEN RAISE EXCEPTION 'Missing two recipients'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.auto_clock_notifications WHERE entry_id=e AND recipient_kind='employee' AND recipient='auto-clock@example.invalid') THEN RAISE EXCEPTION 'Wrong employee recipient'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.auto_clock_notifications WHERE entry_id=e AND recipient_kind='admin' AND recipient='post@apartstavanger.no') THEN RAISE EXCEPTION 'Wrong admin recipient'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.audit_logs WHERE entity_id=e::text AND action='auto_clock_out' AND actor_id IS NULL AND details->'after'->>'ended_at' IS NOT NULL) THEN RAISE EXCEPTION 'Missing audit'; END IF;
 result:=public.close_overdue_time_entries(emp);
 IF result->>'closed'<>'0' OR (SELECT count(*) FROM public.auto_clock_notifications WHERE entry_id=e)<>2 THEN RAISE EXCEPTION 'Retry duplicates'; END IF;
 UPDATE public.time_entries SET ended_at=started_at+interval '8 hours',source='manual' WHERE id=e;
 IF NOT EXISTS(SELECT 1 FROM public.time_entries WHERE id=e AND auto_clocked_out) THEN RAISE EXCEPTION 'Correction erased provenance'; END IF;
 INSERT INTO public.time_entries(organization_id,employee_id,started_at,source,created_by) VALUES(org,emp,now()-interval '11 hours 59 minutes','manual',actor) RETURNING id INTO recent;
 result:=public.close_overdue_time_entries(emp);
 IF result->>'closed'<>'0' THEN RAISE EXCEPTION 'Closed too early'; END IF;
 UPDATE public.time_entries SET ended_at=now() WHERE id=recent;
 result:=public.close_overdue_time_entries(emp);
 IF EXISTS(SELECT 1 FROM public.auto_clock_notifications WHERE entry_id=recent) THEN RAISE EXCEPTION 'Notified normal clockout'; END IF;
 -- Exact boundary and locked-period protection.
 INSERT INTO public.time_entries(organization_id,employee_id,started_at,source,created_by) VALUES(org,emp,now()-interval '12 hours','manual',actor) RETURNING id INTO manual;
 INSERT INTO public.month_approvals(organization_id,employee_id,month_start,status,approved_by,approved_at)
 VALUES(org,emp,date_trunc('month',(now()-interval '12 hours') AT TIME ZONE 'Europe/Oslo')::date,'locked',actor,now());
 result:=public.close_overdue_time_entries(emp);
 IF result->>'failed'<>'1' OR NOT EXISTS(SELECT 1 FROM public.time_entries WHERE id=manual AND ended_at IS NULL) THEN RAISE EXCEPTION 'Bypassed lock'; END IF;
 UPDATE public.month_approvals SET status='open' WHERE employee_id=emp;
 result:=public.close_overdue_time_entries(emp);
 IF result->>'closed'<>'1' THEN RAISE EXCEPTION 'Exact boundary failed'; END IF;
 -- Isolate queue fixtures from any unrelated pending work without persisting changes.
 UPDATE public.auto_clock_notifications SET next_attempt_at=now()+interval '1 day' WHERE entry_id<>e;
 SELECT * INTO j FROM public.claim_auto_clock_notification();
 IF j.id IS NULL OR j.attempts<>1 THEN RAISE EXCEPTION 'Claim failed'; END IF;
 first_lease:=j.lease_token;
 IF public.finish_auto_clock_notification(j.id,gen_random_uuid(),'wrong-worker',NULL,false) THEN RAISE EXCEPTION 'Stale worker could ack'; END IF;
 IF NOT public.finish_auto_clock_notification(j.id,first_lease,NULL,'Simulated HTTP 429',false) THEN RAISE EXCEPTION 'Retry not saved'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.auto_clock_notifications WHERE id=j.id AND sent_at IS NULL AND next_attempt_at>now() AND NOT needs_review) THEN RAISE EXCEPTION 'Failure incorrectly sent'; END IF;
 UPDATE public.auto_clock_notifications SET next_attempt_at=now()+interval '1 day' WHERE id<>j.id;
 UPDATE public.auto_clock_notifications SET next_attempt_at=now() WHERE id=j.id;
 SELECT * INTO j FROM public.claim_auto_clock_notification();
 IF j.lease_token=first_lease OR j.attempts<>2 THEN RAISE EXCEPTION 'Retry lease not renewed'; END IF;
 IF NOT public.finish_auto_clock_notification(j.id,j.lease_token,'mock-provider-id',NULL,false) THEN RAISE EXCEPTION 'Ack failed'; END IF;
 IF EXISTS(SELECT 1 FROM public.claim_auto_clock_notification()) THEN RAISE EXCEPTION 'Sent entry claimed twice'; END IF;
 UPDATE public.auto_clock_notifications SET first_attempt_at=now()-interval '24 hours',next_attempt_at=now() WHERE entry_id=e AND sent_at IS NULL;
 PERFORM public.claim_auto_clock_notification();
 IF EXISTS(SELECT 1 FROM public.auto_clock_notifications WHERE entry_id=e AND sent_at IS NULL AND NOT needs_review) THEN RAISE EXCEPTION 'Unsafe late retry'; END IF;
 IF has_table_privilege('authenticated','public.auto_clock_notifications','SELECT') OR has_table_privilege('anon','public.auto_clock_worker_config','SELECT') OR has_function_privilege('authenticated','public.close_overdue_time_entries(uuid)','EXECUTE') OR has_function_privilege('service_role','public.run_auto_clock_job()','EXECUTE') THEN RAISE EXCEPTION 'Unexpected public/worker access'; END IF;
END $$;
ROLLBACK;
