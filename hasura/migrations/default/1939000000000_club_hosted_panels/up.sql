-- Club fleet servers get a hosted_servers row so owners/admins can use the
-- same full hosting control panel (RCON, gameplay, VIP, chat ads, bans).
-- Lifecycle billing must ignore these rows (see HostedServersService).

ALTER TABLE public.hosted_servers
  ADD COLUMN IF NOT EXISTS club_id uuid REFERENCES public.clubs (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS hosted_servers_club_idx
  ON public.hosted_servers (club_id)
  WHERE club_id IS NOT NULL;

COMMENT ON COLUMN public.hosted_servers.club_id IS
  'When set, this hosted panel manages a club section server and never expires via rental lifecycle';

INSERT INTO public.hosted_servers (
  server_id,
  owner_steam_id,
  slots,
  label,
  status,
  expires_at,
  section_mode,
  club_id
)
SELECT
  s.id,
  c.owner_steam_id,
  COALESCE(NULLIF(s.max_players, 0), 16),
  COALESCE(NULLIF(s.label, ''), 'Club server'),
  'active',
  TIMESTAMPTZ '2099-01-01 00:00:00+00',
  s.section_mode,
  s.club_id
FROM public.servers s
JOIN public.clubs c ON c.id = s.club_id
WHERE s.club_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM public.hosted_servers h
     WHERE h.server_id = s.id
  );

UPDATE public.hosted_servers h
   SET club_id = s.club_id,
       status = 'active',
       expires_at = GREATEST(h.expires_at, TIMESTAMPTZ '2099-01-01 00:00:00+00'),
       section_mode = COALESCE(s.section_mode, h.section_mode),
       label = COALESCE(NULLIF(s.label, ''), h.label),
       slots = COALESCE(NULLIF(s.max_players, 0), h.slots),
       owner_steam_id = c.owner_steam_id,
       updated_at = now()
  FROM public.servers s
  JOIN public.clubs c ON c.id = s.club_id
 WHERE h.server_id = s.id
   AND s.club_id IS NOT NULL;
