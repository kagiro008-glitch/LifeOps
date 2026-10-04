-- Apply once to an existing LifeOps database to add guardian-approved limit requests.
create table if not exists public.guardian_limit_requests (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references auth.users(id) on delete cascade,
  guardian_email text not null,
  current_limit_paise integer not null check (current_limit_paise between 0 and 5000000),
  requested_limit_paise integer not null check (requested_limit_paise between 0 and 5000000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (lower(guardian_email) <> '')
);

alter table public.guardian_limit_requests enable row level security;
grant usage on schema public to authenticated;
grant select, insert on public.guardian_limit_requests to authenticated;
revoke insert, update, delete on public.user_settings from authenticated;
grant select on public.user_settings to authenticated;

drop policy if exists "students and invited guardians read limit requests" on public.guardian_limit_requests;
create policy "students and invited guardians read limit requests" on public.guardian_limit_requests for select using (
  student_id = auth.uid()
  or (
    lower(guardian_email) = lower(coalesce(auth.email(), ''))
    and exists (select 1 from public.profiles p where p.id = auth.uid() and p.account_type = 'guardian')
  )
);

drop policy if exists "students create pending limit requests" on public.guardian_limit_requests;
create policy "students create pending limit requests" on public.guardian_limit_requests for insert with check (
  student_id = auth.uid()
  and lower(guardian_email) <> lower(coalesce(auth.email(), ''))
  and status = 'pending'
);

create or replace function public.save_user_preferences(theme_arg text, retention_days_arg integer)
returns public.user_settings
language plpgsql security definer set search_path = public
as $$
declare saved public.user_settings;
begin
  if auth.uid() is null or theme_arg not in ('system', 'light', 'dark')
     or retention_days_arg not between 7 and 365 then
    raise exception 'Valid theme and chat retention settings are required.';
  end if;
  insert into public.user_settings(user_id, theme, chat_retention_days)
    values (auth.uid(), theme_arg, retention_days_arg)
    on conflict (user_id) do update
      set theme = excluded.theme,
          chat_retention_days = excluded.chat_retention_days,
          updated_at = now()
    returning * into saved;
  return saved;
end;
$$;

create or replace function public.respond_to_guardian_limit_request(request_id_arg uuid, decision_arg text)
returns public.guardian_limit_requests
language plpgsql security definer set search_path = public
as $$
declare approval public.guardian_limit_requests;
begin
  if auth.uid() is null or decision_arg not in ('approved', 'declined')
     or not exists (
       select 1 from public.profiles p
       join auth.users u on u.id = p.id
       where p.id = auth.uid() and p.account_type = 'guardian'
         and u.email_confirmed_at is not null
     ) then
    raise exception 'Sign in with a verified guardian account to respond.';
  end if;

  select * into approval from public.guardian_limit_requests
    where id = request_id_arg
      and lower(guardian_email) = lower(coalesce(auth.email(), ''))
      and status = 'pending'
    for update;
  if not found then
    raise exception 'This request is not pending for the signed-in guardian.';
  end if;

  update public.guardian_limit_requests
    set status = decision_arg, responded_at = now()
    where id = request_id_arg
    returning * into approval;

  if decision_arg = 'approved' then
    insert into public.user_settings(user_id, payment_approval_limit_paise)
      values (approval.student_id, approval.requested_limit_paise)
      on conflict (user_id) do update
        set payment_approval_limit_paise = excluded.payment_approval_limit_paise,
            updated_at = now();
    insert into public.guardian_links(student_id, guardian_id, status)
      values (approval.student_id, auth.uid(), 'verified')
      on conflict (student_id, guardian_id) do update set status = 'verified';
  end if;
  return approval;
end;
$$;

revoke all on function public.save_user_preferences(text, integer) from public;
revoke all on function public.respond_to_guardian_limit_request(uuid, text) from public;
grant execute on function public.save_user_preferences(text, integer) to authenticated;
grant execute on function public.respond_to_guardian_limit_request(uuid, text) to authenticated;
