alter table public.rides
  add column if not exists stripe_checkout_session_id varchar(255);

create unique index if not exists ix_rides_stripe_checkout_session_id
  on public.rides(stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;
