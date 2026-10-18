alter table public.drivers add column if not exists latitude double precision;
alter table public.drivers add column if not exists longitude double precision;

alter table public.rides add column if not exists pickup_latitude double precision;
alter table public.rides add column if not exists pickup_longitude double precision;
alter table public.rides add column if not exists destination_latitude double precision;
alter table public.rides add column if not exists destination_longitude double precision;
alter table public.rides add column if not exists otp varchar(4);
alter table public.drivers drop constraint if exists drivers_ride_type_check;
alter table public.rides drop constraint if exists rides_ride_type_check;

update public.drivers set ride_type = case ride_type
  when 'mini' then 'auto'
  when 'comfort' then 'cab'
  when 'xl' then 'maxi_cab'
  else ride_type
end where ride_type in ('mini', 'comfort', 'xl');

create table if not exists public.ride_modes (
  id varchar(20) primary key,
  name varchar(40) not null,
  description varchar(120) not null,
  icon varchar(8) not null,
  seats integer not null,
  base_fare_paise integer not null,
  per_km_paise integer not null,
  per_minute_paise integer not null,
  active boolean not null default true
);

insert into public.ride_modes (id, name, description, icon, seats, base_fare_paise, per_km_paise, per_minute_paise) values
  ('bike', 'Bike', 'Quick solo rides', '🏍️', 1, 2000, 800, 100),
  ('auto', 'Auto', 'Easy city rides', '🛺', 3, 3000, 1500, 100),
  ('cab', 'Cab', 'Comfortable private ride', '🚕', 4, 5000, 1500, 150),
  ('maxi_cab', 'Maxi-cab', 'Room for up to 6', '🚐', 6, 10000, 2200, 200)
on conflict (id) do nothing;

create index if not exists ix_drivers_available_mode on public.drivers(available, ride_type);
create index if not exists ix_rides_unassigned on public.rides(status, ride_type, created_at);

alter table public.ride_modes enable row level security;
