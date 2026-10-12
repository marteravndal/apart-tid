-- Internal service tables deliberately have no employee-facing access.
CREATE POLICY "Worker-only notification queue" ON public.auto_clock_notifications TO authenticated USING(false) WITH CHECK(false);
CREATE POLICY "Worker-only configuration" ON public.auto_clock_worker_config TO authenticated USING(false) WITH CHECK(false);
-- One minute cadence; recorded end is exactly 12 elapsed hours after the start.
SELECT cron.schedule('apart-auto-clock-out','* * * * *','SELECT public.run_auto_clock_job();');
