begin;
do $$
declare q public.qr_codes%rowtype; e uuid; r jsonb; i integer; before_hash text;
begin
  select * into strict q from public.qr_codes where revoked_at is null and valid_from<=now() and expires_at>now() limit 1;
  select id into strict e from public.employees where organization_id=(select organization_id from public.worksites where id=q.worksite_id) and active limit 1;
  before_hash:=q.token_hash;
  if q.reserve_code !~ '^[0-9]{8}$' then raise exception 'Invalid code format'; end if;
  delete from public.qr_reserve_attempts where employee_id=e;
  r:=public.verify_qr_reserve(e,q.worksite_id,q.reserve_code);
  if r->>'status'<>'valid' then raise exception 'Valid code rejected'; end if;
  for i in 1..5 loop
    r:=public.verify_qr_reserve(e,q.worksite_id,'invalid-test');
    if r->>'status'<>'invalid' then raise exception 'Wrong code accepted'; end if;
  end loop;
  r:=public.verify_qr_reserve(e,q.worksite_id,q.reserve_code);
  if r->>'status'<>'limited' then raise exception 'Rate limit failed'; end if;
  update public.qr_reserve_attempts set window_started_at=now()-interval '16 minutes' where employee_id=e;
  r:=public.verify_qr_reserve(e,q.worksite_id,q.reserve_code);
  if r->>'status'<>'valid' then raise exception 'Recovery failed'; end if;
  update public.qr_codes set revoked_at=now() where id=q.id;
  r:=public.verify_qr_reserve(e,q.worksite_id,q.reserve_code);
  if r->>'status'<>'invalid' then raise exception 'Revocation failed'; end if;
  update public.qr_codes set revoked_at=null,expires_at=now()-interval '1 second' where id=q.id;
  r:=public.verify_qr_reserve(e,q.worksite_id,q.reserve_code);
  if r->>'status'<>'invalid' then raise exception 'Expiry failed'; end if;
  if (select token_hash from public.qr_codes where id=q.id)<>before_hash then raise exception 'Original QR changed'; end if;
  if has_function_privilege('authenticated','public.verify_qr_reserve(uuid,uuid,text)','EXECUTE') or has_function_privilege('anon','public.verify_qr_reserve(uuid,uuid,text)','EXECUTE') then raise exception 'RPC exposed'; end if;
  if has_table_privilege('authenticated','public.qr_codes','SELECT') or has_table_privilege('anon','public.qr_reserve_attempts','SELECT') then raise exception 'Data exposed'; end if;
end $$;
rollback;
select 'PASS: correct code, five failures, lockout, recovery, revocation, expiry, original QR preservation and permissions; all test writes rolled back' as verification;
