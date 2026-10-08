# Ukesluttkontroll

The ADMIN tab uses `weekly-review.js` → the authenticated `weekly-review` Edge Function → the service-only `weekly_review` database RPC.

- Weeks are Monday–Sunday in Europe/Oslo and assigned by actual clock-in date. A Sunday overnight entry stays in that week; Monday 00:00 belongs to the next week.
- Review and corrections are available before closing. Employee and global closing require the following Monday at 08:00 Oslo time and completed approvals. Open/zero-length/future-ended entries cannot be approved.
- Each entry and payroll adjustment has an approval fingerprint. Corrections through any writer invalidate it. Published planned shifts without a matched recording require an explicit documented resolution; resolution does not create pay or absence hours.
- Employee closing freezes hours, rates, employee label and payroll codes. Global closing requires every relevant employee to have a current employee lock, including employees with unresolved planned shifts.
- Short database table locks serialize closing with time, adjustment and published-roster mutations. Database triggers protect old and new start weeks for corrections and prevent insertion or deletion into locked weeks. Month closing requires all contributing weeks to be closed.
- Reopening requires a reason, preserves former report versions and clears the affected approvals and shift resolutions. Reopening one employee also supersedes the global report while preserving other employee locks. An affected locked payroll month blocks reopening.
- Premium windows match `_shared/payroll-premiums.ts`: weekday 21:00–24:00 evening, daily 00:00–06:00 night, Saturday 18:00–24:00 and Sunday 06:00–24:00 weekend. DST uses elapsed hours. Sickness hours receive no premiums.
- Costs use recorded hourly pay. Overtime adjustments represent the 40%/100% premium on top of ordinary paid work. Missing hourly/premium rates are explicitly marked incomplete; monthly pay is not silently converted to an hourly rate.
- PDF and Excel-compatible UTF-8 CSV export the selected frozen report revision. CSV text is protected against formula injection. No emails are sent.
- Existing month review/locking is available under Reports → Month end. Entries retain the existing start-date allocation to months, so cross-boundary shifts are not counted twice.

## Verification

Run from repository root (provide `pdf-lib@1.17.1` and `jsdom@26.1.0` via NODE_PATH if not installed locally):

```
node --test tests/weekly-review.test.cjs tests/clock-register.test.cjs tests/report-premiums.test.cjs
node tests/weekly-review.dom.cjs
node tests/clock-register.dom.cjs
node tests/roster-attendance.dom.cjs
```

`tests/weekly-review.sql` exercises the actual RPC and guards in a rolled-back transaction, with synthetic employees and dates. It does not approve real employee data. PDF fixtures also cover multipage reports, long names and missing-rate warnings.
