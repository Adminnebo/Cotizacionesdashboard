-- Página de Usuarios: ocultar usuarios + marcar origen.
-- Ejecutar UNA vez en el SQL Editor de Supabase (proyecto de auth del panel).

-- Botón "Ocultar" del super_admin (no borra: solo lo saca del listado).
alter table public.profiles
  add column if not exists hidden boolean not null default false;

-- Marca de origen: 'panel' para los usuarios creados desde esta página.
-- Los usuarios previos quedan en NULL (se muestran como "previo").
alter table public.profiles
  add column if not exists created_via text;
