-- One-shot on the panel DB (after image roll / hasura migrate).
-- 1) Hide deleted/disabled maps from veto (v_pool_maps).
-- 2) Ensure Trios map rows exist for every Competitive map.
-- 3) Sync Trios seed pool membership from the enabled Competitive pool.

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
)
SELECT
  m.name,
  'Trios'::text,
  m.active_pool,
  m.workshop_map_id,
  m.poster,
  m.patch,
  m.label,
  true
FROM public.maps m
WHERE m.type = 'Competitive'
  AND m.deleted_at IS NULL
ON CONFLICT ("name", "type") DO UPDATE SET
  "active_pool" = EXCLUDED."active_pool",
  "workshop_map_id" = EXCLUDED."workshop_map_id",
  "poster" = EXCLUDED."poster",
  "patch" = EXCLUDED."patch",
  "label" = EXCLUDED."label",
  "enabled" = true,
  "deleted_at" = NULL;

INSERT INTO public.map_pools ("type", "enabled", "seed")
SELECT 'Trios', true, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.map_pools
  WHERE type = 'Trios' AND enabled = true
);

-- Replace Trios pool links with Competitive pool maps (matched by name).
WITH comp AS (
  SELECT DISTINCT cm.name
  FROM public.map_pools cp
  JOIN public._map_pool cmp ON cmp.map_pool_id = cp.id
  JOIN public.maps cm ON cm.id = cmp.map_id
  WHERE cp.type = 'Competitive'
    AND cp.enabled = true
    AND cm.deleted_at IS NULL
    AND cm.enabled = true
),
trios_pool AS (
  SELECT id
  FROM public.map_pools
  WHERE type = 'Trios' AND enabled = true
  ORDER BY seed DESC
  LIMIT 1
)
DELETE FROM public._map_pool mp
USING trios_pool tp
WHERE mp.map_pool_id = tp.id
  AND NOT EXISTS (
    SELECT 1
    FROM public.maps tm
    JOIN comp ON comp.name = tm.name
    WHERE tm.id = mp.map_id
      AND tm.type = 'Trios'
  );

WITH comp AS (
  SELECT DISTINCT cm.name
  FROM public.map_pools cp
  JOIN public._map_pool cmp ON cmp.map_pool_id = cp.id
  JOIN public.maps cm ON cm.id = cmp.map_id
  WHERE cp.type = 'Competitive'
    AND cp.enabled = true
    AND cm.deleted_at IS NULL
    AND cm.enabled = true
),
trios_pool AS (
  SELECT id
  FROM public.map_pools
  WHERE type = 'Trios' AND enabled = true
  ORDER BY seed DESC
  LIMIT 1
)
INSERT INTO public._map_pool (map_id, map_pool_id)
SELECT tm.id, tp.id
FROM trios_pool tp
CROSS JOIN comp
JOIN public.maps tm
  ON tm.name = comp.name
 AND tm.type = 'Trios'
 AND tm.deleted_at IS NULL
 AND tm.enabled = true
ON CONFLICT DO NOTHING;
