# Attendance references on the administrator roster

The roster previously fetched only entries with a persisted `scheduled_shift_id`. Normal employee location punches have no such link, so the UI incorrectly offered manual stamping for shifts with existing attendance.

The read-only `roster_attendance` action now fetches organization-scoped current roster slots and attendance, including neighbouring days. Persisted links take priority. Other entries are associated for display by employee and time overlap (at most 12 hours from planned start). Early open entries use the nearest starting shift within the existing two-hour early-arrival window. Substantial overlap with multiple slots or indistinguishable candidates is marked for review, rather than silently selecting a slot. An explicit link to a slot now assigned to another employee is also flagged.

These associations do not update `time_entries`, shift assignments, approvals, payroll or audit records. Deleted entries are not returned. Multiple entries for one shift retain all references. Missing/query-failed/truncated data cannot be rendered as a successful empty attendance response. The loader permits only one week's requested slots, scopes every database read to the authenticated active administrator's organization and returns only attendance display fields.

The UI shows open/closed/automatic/manual/sick-pay state and clickable ST references. Ambiguous links show Kontroller kobling and suppress the backfill button. References open the existing Stempling register with an exact reference filter; no date filter excludes an overnight punch. A reference confirms a time record, not that the entire planned shift was worked or approved. Existing database overlap/locking checks continue to protect manual backfill.

Verified with matching unit tests (overnight, early midnight, neighbouring weeks, multiple intervals, open punches, ambiguous/changed slots, access control and database failures), roster DOM tests including exact-reference navigation and existing backfill flow, plus read-only comparison against the user's week 45 roster. Live data is not committed to the repository.
