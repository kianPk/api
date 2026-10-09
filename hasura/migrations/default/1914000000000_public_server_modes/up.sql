-- The Duels, AWP and 2x2 starter modes (hasura/enums/game-modes.sql) run on
-- Arenas and MapChooser. Record the intent to install both so nodes converge
-- to them on their own. Once, as a migration: the enum file re-applies, and an
-- operator who later uninstalls one must not have it come back on the next
-- boot. Skipped for a plugin the registry has not synced into the catalog yet.
INSERT INTO public.game_plugin_installs (plugin_slug, version, channel, enabled)
SELECT slug, NULL, 'Auto', true
  FROM public.game_plugins
 WHERE slug IN ('arenas', 'map-chooser')
ON CONFLICT (plugin_slug) DO NOTHING;
