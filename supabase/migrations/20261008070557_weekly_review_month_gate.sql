-- Month closing can only use completed weekly reviews. The lock ordering matches weekly_review.
CREATE FUNCTION public.guard_weekly_month_close() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
 LOCK TABLE public.time_entries,public.payroll_adjustments,public.shift_schedules,public.weekly_period_locks IN SHARE ROW EXCLUSIVE MODE;
 IF EXISTS(
  SELECT 1 FROM (
   SELECT public.review_week(started_at) AS week_start FROM public.time_entries WHERE organization_id=NEW.organization_id
    AND started_at>=NEW.month_start::timestamp AT TIME ZONE 'Europe/Oslo'
    AND started_at<(NEW.month_start+interval '1 month')::timestamp AT TIME ZONE 'Europe/Oslo'
   UNION SELECT date_trunc('week',work_date)::date FROM public.payroll_adjustments WHERE organization_id=NEW.organization_id AND work_date>=NEW.month_start AND work_date<NEW.month_start+interval '1 month'
  ) w WHERE NOT EXISTS(SELECT 1 FROM public.weekly_period_locks l WHERE l.organization_id=NEW.organization_id AND l.week_start=w.week_start AND l.superseded_at IS NULL)
 ) THEN RAISE EXCEPTION 'Fullfør og lås ukene i Ukesluttkontroll før måneden låses.'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_weekly_month_close() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guard_weekly_month_close() TO service_role;
CREATE TRIGGER guard_weekly_month_close BEFORE INSERT ON public.month_locks FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_month_close();

CREATE FUNCTION public.guard_weekly_snapshots() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['superseded_at','reopened_by','reopen_reason']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['superseded_at','reopened_by','reopen_reason'])
 THEN RAISE EXCEPTION 'Et låst ukesgrunnlag kan bare gjenåpnes. Tidligere rapportversjoner beholdes.'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_weekly_snapshots() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.guard_weekly_snapshots() TO service_role;
CREATE TRIGGER immutable_weekly_snapshot BEFORE UPDATE OR DELETE ON public.weekly_employee_locks FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_snapshots();
CREATE TRIGGER immutable_weekly_snapshot BEFORE UPDATE OR DELETE ON public.weekly_period_locks FOR EACH ROW EXECUTE FUNCTION public.guard_weekly_snapshots();
