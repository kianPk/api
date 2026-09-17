-- Hide deleted / disabled maps from veto UIs (map_pools.maps → v_pool_maps)

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
