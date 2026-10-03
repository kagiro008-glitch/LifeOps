-- Apply in the Supabase SQL editor for a new LifeOps project.
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  account_type text not null default 'student' check (account_type in ('student', 'guardian')),
  created_at timestamptz not null default now()
);

create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 180),
  notes text not null default '' check (char_length(notes) <= 2000),
  due_at timestamptz,
  status text not null default 'open' check (status in ('open', 'in_progress', 'done', 'cancelled')),
  created_via text not null default 'manual' check (created_via in ('manual', 'chat', 'voice')),
  conversation_id uuid,
  requires_payment boolean not null default false,
  amount_paise integer check (amount_paise is null or amount_paise between 1 and 5000000),
  payment_method text check (payment_method is null or payment_method in ('upi', 'card')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  conversation_id uuid not null,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 4000),
  source text not null default 'chat' check (source in ('chat', 'voice')),
  created_at timestamptz not null default now()
);

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payment_approval_limit_paise integer not null default 5000000 check (payment_approval_limit_paise between 0 and 5000000),
  chat_retention_days integer not null default 90 check (chat_retention_days between 7 and 365),
  require_guardian_approval boolean not null default true,
  theme text not null default 'system' check (theme in ('system', 'light', 'dark')),
  updated_at timestamptz not null default now()
);

create table if not exists public.guardian_invitations (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references auth.users(id) on delete cascade,
  guardian_email text not null,
  invite_hash text not null unique,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (student_id, guardian_email, status)
);

create table if not exists public.guardian_links (
  student_id uuid not null references auth.users(id) on delete cascade,
  guardian_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'verified' check (status in ('verified', 'revoked')),
  created_at timestamptz not null default now(),
  primary key (student_id, guardian_id),
  check (student_id <> guardian_id)
);

create table if not exists public.payment_requests (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete set null,
  description text not null check (char_length(description) between 1 and 180),
  amount_paise integer not null check (amount_paise between 1 and 5000000),
  method text not null check (method in ('upi', 'card')),
  status text not null default 'awaiting_guardian' check (status in ('awaiting_guardian', 'approved', 'declined', 'checkout_pending', 'paid', 'failed', 'cancelled')),
  approved_by uuid references auth.users(id),
  provider_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_lifeops_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles(id, display_name, account_type)
    values (
      new.id,
      left(coalesce(new.raw_user_meta_data->>'display_name', ''), 80),
      case when new.raw_user_meta_data->>'account_type' = 'guardian' then 'guardian' else 'student' end
    )
    on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_lifeops on auth.users;
create trigger on_auth_user_created_lifeops
  after insert on auth.users
  for each row execute function public.handle_new_lifeops_user();

insert into public.profiles(id, display_name, account_type)
select
  id,
  left(coalesce(raw_user_meta_data->>'display_name', ''), 80),
  case when raw_user_meta_data->>'account_type' = 'guardian' then 'guardian' else 'student' end
from auth.users
on conflict (id) do nothing;

alter table public.profiles enable row level security;
alter table public.tasks enable row level security;
alter table public.conversation_messages enable row level security;
alter table public.user_settings enable row level security;
alter table public.guardian_invitations enable row level security;
alter table public.guardian_links enable row level security;
alter table public.payment_requests enable row level security;

grant usage on schema public to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.tasks to authenticated;
grant select, insert, update, delete on public.conversation_messages to authenticated;
grant select, insert, update on public.user_settings to authenticated;
grant select on public.guardian_invitations to authenticated;
grant select on public.guardian_links to authenticated;
grant select, insert, update on public.payment_requests to authenticated;

create policy "users read own profile" on public.profiles for select using (id = auth.uid());
create policy "users create own profile" on public.profiles for insert with check (id = auth.uid());
create policy "users update own profile" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

create policy "users manage own tasks" on public.tasks for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "users manage own messages" on public.conversation_messages for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "users manage own settings" on public.user_settings for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "students read own invitations" on public.guardian_invitations for select using (student_id = auth.uid());
create policy "users read their guardian links" on public.guardian_links for select using (student_id = auth.uid() or guardian_id = auth.uid());
create policy "students read own payment requests" on public.payment_requests for select using (student_id = auth.uid());
create policy "students create own payment requests" on public.payment_requests for insert with check (student_id = auth.uid() and status = 'awaiting_guardian' and approved_by is null);
create policy "students cancel own pending payment requests" on public.payment_requests for update using (student_id = auth.uid() and status = 'awaiting_guardian') with check (student_id = auth.uid() and status in ('awaiting_guardian', 'cancelled') and approved_by is null);
create policy "guardians read linked payment requests" on public.payment_requests for select using (
  exists (select 1 from public.guardian_links l where l.student_id = payment_requests.student_id and l.guardian_id = auth.uid() and l.status = 'verified')
);
create policy "guardians approve or decline linked requests" on public.payment_requests for update using (
  status = 'awaiting_guardian' and exists (
    select 1 from public.guardian_links l where l.student_id = payment_requests.student_id and l.guardian_id = auth.uid() and l.status = 'verified'
  )
) with check (status in ('approved', 'declined') and approved_by = auth.uid());

create or replace function public.enforce_payment_request_rules()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare payment_cap integer;
begin
  if tg_op = 'INSERT' then
    if auth.uid() is null or new.student_id <> auth.uid()
       or new.status <> 'awaiting_guardian' or new.approved_by is not null
       or not exists (
         select 1 from public.guardian_links l
         where l.student_id = new.student_id and l.status = 'verified'
       ) then
      raise exception 'A linked guardian is required to create a payment request.';
    end if;
    select payment_approval_limit_paise into payment_cap
      from public.user_settings where user_id = new.student_id;
    if new.amount_paise > coalesce(payment_cap, 5000000) or coalesce(payment_cap, 5000000) = 0 then
      raise exception 'Payment request exceeds the configured account limit.';
    end if;
    if new.task_id is not null and not exists (
      select 1 from public.tasks t where t.id = new.task_id
        and t.user_id = new.student_id and t.requires_payment
        and t.amount_paise = new.amount_paise and t.payment_method = new.method
    ) then
      raise exception 'Payment request must match the student''s payment task.';
    end if;
    return new;
  end if;

  if new.id <> old.id or new.student_id <> old.student_id
     or new.task_id is distinct from old.task_id
     or new.description <> old.description
     or new.amount_paise <> old.amount_paise
     or new.method <> old.method
     or new.created_at <> old.created_at
     or old.status <> 'awaiting_guardian' then
    raise exception 'Payment request details are immutable and only pending requests can change.';
  end if;

  if auth.uid() = old.student_id then
    if new.status <> 'cancelled' or new.approved_by is not null then
      raise exception 'Students can only cancel their own pending payment request.';
    end if;
  elsif new.status not in ('approved', 'declined')
     or new.approved_by is distinct from auth.uid()
     or not exists (
       select 1 from public.guardian_links l
       where l.student_id = old.student_id and l.guardian_id = auth.uid() and l.status = 'verified'
     ) then
    raise exception 'Only a linked guardian can approve or decline this request.';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists enforce_payment_request_rules on public.payment_requests;
create trigger enforce_payment_request_rules
  before insert or update on public.payment_requests
  for each row execute function public.enforce_payment_request_rules();

create or replace function public.create_guardian_invitation(guardian_email_arg text)
returns table (invite_id uuid, invite_code text, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions
as $$
declare code text := encode(gen_random_bytes(24), 'hex');
begin
  if auth.uid() is null
     or not exists (select 1 from public.profiles p where p.id = auth.uid() and p.account_type = 'student')
     or lower(coalesce(auth.email(), '')) = lower(trim(guardian_email_arg)) then
    raise exception 'A signed-in student and a different guardian email are required.';
  end if;
  insert into public.guardian_invitations(student_id, guardian_email, invite_hash)
    values (auth.uid(), lower(trim(guardian_email_arg)), encode(digest(code, 'sha256'), 'hex'))
    returning guardian_invitations.id, guardian_invitations.expires_at into invite_id, expires_at;
  return query select invite_id, code, expires_at;
end;
$$;

create or replace function public.accept_guardian_invitation(invite_code_arg text)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare invitation public.guardian_invitations%rowtype;
begin
  if auth.uid() is null then raise exception 'Sign in to accept a guardian invitation.'; end if;
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.account_type = 'guardian') then
    raise exception 'Sign in with a guardian account to accept this invitation.';
  end if;
  if not exists (select 1 from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null) then
    raise exception 'Verify this guardian account email before accepting the invitation.';
  end if;
  select * into invitation from public.guardian_invitations
    where invite_hash = encode(extensions.digest(invite_code_arg, 'sha256'), 'hex')
      and status = 'pending' and expires_at > now()
    for update;
  if not found or lower(invitation.guardian_email) <> lower(coalesce(auth.email(), '')) then
    raise exception 'Invitation is invalid, expired, or belongs to a different email.';
  end if;
  insert into public.guardian_links(student_id, guardian_id, status)
    values (invitation.student_id, auth.uid(), 'verified')
    on conflict (student_id, guardian_id) do update set status = 'verified';
  update public.guardian_invitations set status = 'accepted', accepted_at = now() where id = invitation.id;
  return true;
end;
$$;

revoke all on function public.create_guardian_invitation(text) from public;
revoke all on function public.accept_guardian_invitation(text) from public;
grant execute on function public.create_guardian_invitation(text) to authenticated;
grant execute on function public.accept_guardian_invitation(text) to authenticated;
