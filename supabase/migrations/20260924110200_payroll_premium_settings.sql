insert into public.payroll_settings (organization_id,category,payroll_code,label,hourly_rate)
select organizations.id,setting.category::public.payroll_category,setting.payroll_code,setting.label,setting.hourly_rate
from public.organizations
cross join (values
  ('evening','10105','Kveldstillegg',12.20::numeric),
  ('night','10104','Nattillegg',23.19::numeric),
  ('weekend','10106','Helgetillegg',23.19::numeric)
) as setting(category,payroll_code,label,hourly_rate)
on conflict (organization_id,category) do update
set payroll_code=excluded.payroll_code,
    label=excluded.label,
    hourly_rate=excluded.hourly_rate,
    updated_at=now();
