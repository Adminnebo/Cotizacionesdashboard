-- Ocultar usuarios del listado (botón "Ocultar" del super_admin).
-- Ejecutar UNA vez en el SQL Editor de Supabase (proyecto de auth del panel).
alter table public.profiles
  add column if not exists hidden boolean not null default false;
