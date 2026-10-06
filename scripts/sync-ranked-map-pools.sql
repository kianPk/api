-- One-shot on the panel DB (after image roll / hasura migrate).
-- 1) Hide deleted/disabled maps from veto (v_pool_maps).
-- 2) Ensure Rush seed pool contains only rush_001.

DROP VIEW IF EXISTS public.v_pool_maps;
CREATE OR REPLACE VIEW public.v_pool_maps AS
 SELECT _map_pool.map_pool_id,
    maps.id,
    maps.name,
    maps.type,
    maps.label,
    maps.poster,
    maps.patch,
    maps.active_pool,
    maps.workshop_map_id
   FROM public._map_pool
   INNER JOIN public.maps ON _map_pool.map_id = maps.id
  WHERE maps.deleted_at IS NULL
    AND maps.enabled = true;

INSERT INTO public.maps (
  "name", "type", "active_pool", "workshop_map_id", "poster", "patch", "label", "enabled"
) VALUES (
  'rush_001',
  'Rush',
  true,
  null,
  '/img/maps/screenshots/rush_001.webp',
  '/img/maps/icons/rush_001.svg',
  null,
  true
)
ON CONFLICT ("name", "type") DO UPDATE SET
  "active_pool" = true,
  "poster" = EXCLUDED."poster",
  "patch" = EXCLUDED."patch",
  "enabled" = true,
  "deleted_at" = NULL;

INSERT INTO public.map_pools ("type", "enabled", "seed")
SELECT 'Rush', true, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.map_pools
  WHERE type = 'Rush' AND enabled = true
);

DELETE FROM public._map_pool
WHERE map_pool_id IN (
  SELECT id FROM public.map_pools WHERE type = 'Rush' AND enabled = true
);

INSERT INTO public._map_pool (map_id, map_pool_id)
SELECT m.id, p.id
FROM public.maps m
JOIN public.map_pools p
  ON p.type = 'Rush' AND p.enabled = true
WHERE m.type = 'Rush'
  AND m.name = 'rush_001'
  AND m.deleted_at IS NULL
  AND m.enabled = true
ON CONFLICT DO NOTHING;
