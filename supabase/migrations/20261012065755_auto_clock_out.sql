-- The clock and its notifications are committed together. No employee/admin login is needed.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE TABLE public.auto_clock_worker_config (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 secret_hash text NOT NULL
);
ALTER TABLE public.auto_clock_worker_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.auto_clock_worker_config FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.auto_clock_worker_config TO service_role;

-- Generate a dedicated, narrow-purpose worker credential entirely inside the database.
DO $$ DECLARE secret text:=encode(extensions.gen_random_bytes(32),'hex'); BEGIN
 PERFORM vault.create_secret(secret,'apart_auto_clock_worker');
 INSERT INTO public.auto_clock_worker_config(secret_hash) VALUES(encode(extensions.digest(secret,'sha256'),'hex'));
END $$;

CREATE TABLE public.auto_clock_notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES public.organizations(id),
 entry_id uuid NOT NULL, -- Survives soft deletion of the time entry, like its audit log.
 recipient_kind text NOT NULL CHECK(recipient_kind IN ('employee','admin')),
 recipient text NOT NULL,
 payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 first_attempt_at timestamptz,
 attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz,
 lease_token uuid,
 sent_at timestamptz,
 provider_id text,
 last_error text,
 needs_review boolean NOT NULL DEFAULT false,
 UNIQUE(entry_id,recipient_kind)
);
CREATE INDEX auto_clock_pending_idx ON public.auto_clock_notifications(next_attempt_at) WHERE sent_at IS NULL AND NOT needs_review;
ALTER TABLE public.auto_clock_notifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.auto_clock_notifications FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.auto_clock_notifications TO service_role;
CREATE INDEX IF NOT EXISTS time_entries_open_started_idx ON public.time_entries(started_at) WHERE ended_at IS NULL;

CREATE FUNCTION public.close_overdue_time_entries(p_employee_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE e public.time_entries%ROWTYPE; person record; planned jsonb; payload jsonb; closed_count int:=0; failed_count int:=0;
BEGIN
 FOR e IN SELECT * FROM public.time_entries
  WHERE ended_at IS NULL AND kind='work' AND started_at<=now()-interval '12 hours'
    AND (p_employee_id IS NULL OR employee_id=p_employee_id)
  ORDER BY started_at LIMIT 100 FOR UPDATE SKIP LOCKED
 LOOP
  BEGIN
   UPDATE public.time_entries SET ended_at=e.started_at+interval '12 hours',auto_clocked_out=true,
    updated_at=now(),note=concat_ws(E'\n',nullif(note,''),'Automatisk utstemplet etter 12 timer. Faktisk arbeidstid må kontrolleres av ADMIN.')
   WHERE id=e.id AND ended_at IS NULL;
   IF NOT FOUND THEN CONTINUE; END IF;
   SELECT full_name,email INTO STRICT person FROM public.employees WHERE id=e.employee_id AND organization_id=e.organization_id;
   SELECT x INTO planned FROM public.shift_schedules s CROSS JOIN LATERAL jsonb_array_elements(s.published_snapshot) x
    WHERE s.organization_id=e.organization_id AND s.status='published' AND x->>'employee_id'=e.employee_id::text
     AND (((x->>'work_date')::date + (x->>'start_time')::time) AT TIME ZONE 'Europe/Oslo')-interval '1 hour'<=e.started_at
     AND ((((x->>'work_date')::date+CASE WHEN (x->>'end_time')::time<=(x->>'start_time')::time THEN 1 ELSE 0 END)+(x->>'end_time')::time) AT TIME ZONE 'Europe/Oslo')>e.started_at
    ORDER BY abs(extract(epoch from ((((x->>'work_date')::date+(x->>'start_time')::time) AT TIME ZONE 'Europe/Oslo')-e.started_at))) LIMIT 1;
   payload:=jsonb_build_object('employee_name',person.full_name,'reference_no',e.reference_no,'started_at',e.started_at,'ended_at',e.started_at+interval '12 hours','planned_shift',planned);
   INSERT INTO public.audit_logs(organization_id,actor_id,action,entity_type,entity_id,details)
   VALUES(e.organization_id,NULL,'auto_clock_out','time_entry',e.id::text,jsonb_build_object('employee_id',e.employee_id,'reference_no',e.reference_no,'reason','Automatisk utstemplet etter 12 timer. Kontroller faktisk arbeidstid.','before',jsonb_build_object('started_at',e.started_at,'ended_at',NULL),'after',jsonb_build_object('started_at',e.started_at,'ended_at',e.started_at+interval '12 hours'),'processed_at',now()));
   INSERT INTO public.auto_clock_notifications(organization_id,entry_id,recipient_kind,recipient,payload)
   VALUES(e.organization_id,e.id,'employee',coalesce(person.email,''),payload),(e.organization_id,e.id,'admin','post@apartstavanger.no',payload)
   ON CONFLICT(entry_id,recipient_kind) DO NOTHING;
   closed_count:=closed_count+1;
  EXCEPTION WHEN OTHERS THEN
   -- Preserve payroll locks and let other employees finish if one row cannot be changed.
   failed_count:=failed_count+1;
   IF NOT EXISTS(SELECT 1 FROM public.audit_logs WHERE entity_id=e.id::text AND action='auto_clock_out_failed') THEN
    INSERT INTO public.audit_logs(organization_id,action,entity_type,entity_id,details)
    VALUES(e.organization_id,'auto_clock_out_failed','time_entry',e.id::text,jsonb_build_object('reason','Automatisk utstempling kunne ikke fullføres. ADMIN må kontrollere registreringen.','error_code',SQLSTATE));
   END IF;
  END;
 END LOOP;
 RETURN jsonb_build_object('closed',closed_count,'failed',failed_count);
END $$;
REVOKE ALL ON FUNCTION public.close_overdue_time_entries(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.close_overdue_time_entries(uuid) TO service_role;

CREATE FUNCTION public.claim_auto_clock_notification()
RETURNS SETOF public.auto_clock_notifications LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
 -- Resend retains idempotency keys for 24h. Stop before that window expires.
 UPDATE public.auto_clock_notifications SET needs_review=true,last_error='Varsling må kontrolleres manuelt; fristen for sikre automatiske forsøk er utløpt.'
 WHERE sent_at IS NULL AND NOT needs_review AND first_attempt_at<now()-interval '23 hours' AND (lease_until IS NULL OR lease_until<=now());
 RETURN QUERY
 WITH candidate AS (
  SELECT id FROM public.auto_clock_notifications WHERE sent_at IS NULL AND NOT needs_review AND next_attempt_at<=now()
   AND (lease_until IS NULL OR lease_until<=now()) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED
 )
 UPDATE public.auto_clock_notifications n SET lease_until=now()+interval '5 minutes',lease_token=gen_random_uuid(),
  attempts=attempts+1,first_attempt_at=coalesce(first_attempt_at,now())
 FROM candidate c WHERE n.id=c.id RETURNING n.*;
END $$;
REVOKE ALL ON FUNCTION public.claim_auto_clock_notification() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_auto_clock_notification() TO service_role;

CREATE FUNCTION public.finish_auto_clock_notification(p_id uuid,p_lease_token uuid,p_provider_id text DEFAULT NULL,p_error text DEFAULT NULL,p_permanent boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
 UPDATE public.auto_clock_notifications SET sent_at=CASE WHEN p_provider_id IS NOT NULL THEN now() ELSE NULL END,
 provider_id=p_provider_id,last_error=left(p_error,300),needs_review=p_permanent,
 lease_until=NULL,lease_token=NULL,next_attempt_at=now()+least(interval '30 minutes',interval '1 minute'*power(2,least(attempts,5)))
 WHERE id=p_id AND lease_token=p_lease_token AND sent_at IS NULL;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION public.finish_auto_clock_notification(uuid,uuid,text,text,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finish_auto_clock_notification(uuid,uuid,text,text,boolean) TO service_role;

-- Only the database scheduler may read the worker credential or invoke this function.
CREATE FUNCTION public.run_auto_clock_job()
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 result:=public.close_overdue_time_entries();
 IF EXISTS(SELECT 1 FROM public.auto_clock_notifications WHERE sent_at IS NULL AND NOT needs_review AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<=now())) THEN
  PERFORM net.http_post(url:='https://oslkpuqkppxvbyvegvkn.supabase.co/functions/v1/auto-clock-out',
   headers:=jsonb_build_object('Content-Type','application/json','x-auto-clock-secret',(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='apart_auto_clock_worker')),
   body:='{}'::jsonb,timeout_milliseconds:=60000);
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.run_auto_clock_job() FROM PUBLIC,anon,authenticated,service_role;
-- Scheduling is activated in the release migration, after the worker has been verified.
