# Manual sickness correction and roster absence periods

ADMIN can cancel a manually entered sick leave from Sykefravær or the roster's Fravær denne uken overview. A dialog identifies the employee and dates, explains removal of linked sick-pay adjustments, and requires a reason. No notification is sent. Employee-submitted requests cannot be cancelled with this action.

`admin-absence` validates a current active administrator, derives organization and actor server-side, and invokes the service-only `cancel_manual_sick_leave` RPC. The transaction respects weekly/monthly payroll locks, removes only payroll adjustments linked to this request, and marks the request rejected with cancellation metadata. The rejected status is intentional compatibility with all existing absence/overlap queries. Unrelated time entries and adjustments remain unchanged.

The original request and removed adjustment snapshots are retained in the administrator audit trail. Cancelled manual requests appear in the collapsible history within Sykefravær and are excluded from employee request lists. Repeating cancellation is idempotent. A cancelled record cannot be approved again due to the database constraint; a corrected new request can use the same dates because the duplicate index applies only to pending/approved requests.

Linked followup cases recalculate their bounds from remaining approved requests. If none remain the case closes, its next-followup date clears, and plans/activities/links remain as history. An activity describes the correction. No legal deadline rules are changed.

The roster overview is ADMIN-only, independent of shifts and publishing, and marks every inclusive date in each overlapping absence period, including weekends and dates with no scheduled shifts. The full date range appears alongside the name. Per-day badges distinguish an assigned shift from no shift. The existing employee-facing roster endpoint returns before these administrative data are loaded.

Validation: rolled-back synthetic SQL covers manual-only restriction, active administrator verification, locked week rejection without partial mutation, targeted adjustment removal, audit snapshots, idempotency, shared followup bounds and final case closure. DOM checks cover a full week without shifts, escaped names, cancellation dialog and history. Edge tests check role/auth, bad input, identity scoping and absence of email calls. Existing roster attendance UI regression passed.
