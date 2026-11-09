# Published roster cost overview

ADMIN sees a panel immediately below Siste hendelser. It follows the selected dashboard date and refreshes whenever the dashboard is opened, its date changes, a quick shift edit is published, or Oppdater is pressed.

The existing payroll-dashboard Edge Function accepts the read-only `published_costs` action. It validates an active administrator and derives the organization from their authenticated employee record. It reads only that organization's published schedule snapshots and the necessary wage fields, with batched employee lookups. It returns aggregate costs, never names, individual rates or other private fields. Database failures produce an error, never zero totals. Existing forecast and planning actions are unchanged.

- Day: all shifts starting on the selected date, compared with the same date in the preceding month (clamped to that month's last date).
- Week: the full Monday–Sunday week containing the selected date, compared with the Monday–Sunday week containing the comparison date above. The comparison week may cross a month boundary. Both date ranges are displayed.
- Month: the full calendar month against the full preceding calendar month; months may have different lengths.
- Sources: only the latest `published_snapshot` for each schedule with status `published`; drafts, inactive schedules, actual attendance and forecast extrapolations are excluded. Republishing replaces the old snapshot rather than adding another version.
- Both periods use current registered hourly rates and current evening/night/weekend premiums. This is a comparable plan valuation, not historical paid payroll. No social costs or inferred monthly-salary-to-hourly conversion.
- Reuses the existing Oslo shift boundary and premium functions, including overnight shifts and daylight saving. The whole shift belongs to its start date, matching other payroll reports.
- Published weeks count as coverage for their seven days, including days with no shifts. This does not assert that staffing is sufficient or planning complete. Missing weeks, wage/premium rates or invalid times mark the total incomplete. Known partial costs remain visible, with `≈` and coverage details, but changes are suppressed until both sides are complete. A zero baseline has a NOK change but no percentage.
- Positive change is red, negative green; signs and text also convey direction. Layout is scoped, wraps text, and stacks cards on narrow screens. Existing payroll forecasting remains available separately.

Validation: `node --test tests/published-costs.test.cjs tests/payroll-dashboard.test.cjs`; `NODE_PATH=../test-runtime/node_modules node tests/published-costs.dom.cjs`. Live published schedules and salary fields were read without mutation and run through the same calculator. Production data is not included in tests or the repository.
