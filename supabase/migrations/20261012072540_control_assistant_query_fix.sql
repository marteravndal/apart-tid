CREATE OR REPLACE FUNCTION public.control_assistant(p_org uuid,p_actor uuid,p_action text DEFAULT 'load',p_body jsonb DEFAULT '{}')
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
  'alerts',coalesce((SELECT jsonb_agg(x ORDER BY (x.status='open') DESC,x.severity,x.first_seen DESC,x.id) FROM (SELECT ca.*,coalesce(e.full_name,'Tidligere ADMIN') AS handled_by_name FROM public.control_alerts ca LEFT JOIN public.employees e ON e.auth_user_id=ca.handled_by AND e.organization_id=p_org WHERE ca.organization_id=p_org AND (ca.status='open' OR ca.last_seen>=now()-interval '90 days') ORDER BY (ca.status='open') DESC,ca.severity,ca.first_seen DESC,ca.id LIMIT 1000) x),'[]'),
  'total',(SELECT count(*) FROM public.control_alerts WHERE organization_id=p_org AND (status='open' OR last_seen>=now()-interval '90 days')),
  'health',(SELECT to_jsonb(h)-'organization_id' FROM public.control_scan_health h WHERE organization_id=p_org)) INTO result;
 RETURN result;
END $$;
