# Lønnskostnader on the administrator dashboard

The admin-only `payroll-dashboard` Edge Function validates the signed-in active administrator and derives actor and organization from the database. Its service-only `payroll_dashboard` RPC returns a consistent read of monthly weekly-review data, saved employee snapshots, plans and current rates. Only aggregate cost data, warnings and per-day totals are returned to the browser.

- Actual: completed entries and sick-pay/overtime adjustments. Existing wage rules and start-date month allocation apply. Sick pay has no shift premiums.
- Open entries: elapsed cost is provisional. Entries older than 20 hours are explicitly excluded and flagged; their matching planned shift is retained as unresolved.
- Future planned work: current roster drafts; previous dates: published snapshots. Inactive schedules supply no shifts.
- Forecast: actual + provisional + remaining matched open shifts + upcoming plans + unresolved past plans + inferred future slots. No additional whole-plan total is added to actual costs.
- A closed entry replaces its matched shift even if shorter or longer. Explicit weekly-review resolutions remove missing shifts from the forecast. Sick-pay adjustments offset unmatched same-day planned hours without premiums; partial adjustment allocation is proportional because adjustments have no clock times.
- Missing actual records remain unresolved instead of appearing free. Missing rates, old open entries and uncovered dates make the forecast visibly incomplete. Monthly salaries are not silently converted into hourly wages.
- Locked employee weeks use saved rates and payroll codes. Their records are immutable under the weekly-review guards. Dates and premiums use Europe/Oslo including daylight saving.
- Reference: most recent complete published week before the present week (or month cutoff), searched within 12 weeks. Until completion markers are adopted, the latest published week is used with an explicit unconfirmed-reference warning.
- Inference matches weekdays and missing staffing slots by shift type. Existing employee/time matches take precedence, including substitutions and modified times. Inferred slots exist only in the forecast, never in the roster.
- Finished planning per day is an explicit admin declaration. Its fingerprint includes shift IDs, employee, date, type and times. Any change invalidates completion automatically; stale checkbox updates are rejected. Empty days can be explicitly complete. Marking a day never publishes or notifies anyone.
- Deviation compares finished matched shifts to their planned cost plus extra completed entries. Unresolved shifts are not reported as savings.
- Current rates apply until employee week locking. Dashboard estimates are not a replacement for finalized payroll reports. Monetary amounts in the UI are rounded to whole NOK; API values use cents.

Tests: `node --test tests/payroll-dashboard.test.cjs`; `NODE_PATH=../test-runtime/node_modules node tests/payroll-dashboard.dom.cjs`; rolled-back SQL integration `tests/payroll-dashboard.sql` after migration. Regression tests: report premiums and weekly review.
