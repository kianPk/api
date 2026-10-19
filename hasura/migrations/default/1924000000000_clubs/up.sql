-- YGuard Clubs (FACEIT-style community hubs). Separate from competitive teams.

CREATE TABLE IF NOT EXISTS public.e_club_roles (
  value text PRIMARY KEY,
  description text
);
INSERT INTO public.e_club_roles (value, description) VALUES
  ('owner', 'Club owner'),
  ('admin', 'Club administrator'),
  ('moderator', 'Club moderator'),
  ('member', 'Club member')
ON CONFLICT (value) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.e_club_join_modes (
  value text PRIMARY KEY,
  description text
);
INSERT INTO public.e_club_join_modes (value, description) VALUES
  ('open', 'Anyone can join'),
  ('request', 'Join requires approval'),
  ('invite_only', 'Invite or invite-link only')
ON CONFLICT (value) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.e_club_leaderboard_types (
  value text PRIMARY KEY,
  description text
);
INSERT INTO public.e_club_leaderboard_types (value, description) VALUES
  ('all_time', 'All-time leaderboard'),
  ('season', 'Season leaderboard'),
  ('event', 'Event leaderboard')
ON CONFLICT (value) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.clubs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  short_name text,
  avatar_url text,
  cover_url text,
  description text NOT NULL DEFAULT '',
  join_mode text NOT NULL DEFAULT 'open' REFERENCES public.e_club_join_modes(value),
  owner_steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  min_elo integer,
  min_faceit_level integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS clubs_owner_idx ON public.clubs (owner_steam_id);
CREATE INDEX IF NOT EXISTS clubs_name_lower_idx ON public.clubs (lower(name));

CREATE TABLE IF NOT EXISTS public.club_members (
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON UPDATE CASCADE ON DELETE CASCADE,
  steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' REFERENCES public.e_club_roles(value),
  is_primary boolean NOT NULL DEFAULT false,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (club_id, steam_id)
);
CREATE INDEX IF NOT EXISTS club_members_steam_idx ON public.club_members (steam_id);
CREATE UNIQUE INDEX IF NOT EXISTS club_members_one_primary_per_player
  ON public.club_members (steam_id) WHERE is_primary = true;

ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS primary_club_id uuid REFERENCES public.clubs(id) ON UPDATE CASCADE ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.club_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON UPDATE CASCADE ON DELETE CASCADE,
  steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  invited_by_steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (club_id, steam_id)
);

CREATE TABLE IF NOT EXISTS public.club_invite_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON UPDATE CASCADE ON DELETE CASCADE,
  code text NOT NULL UNIQUE,
  created_by_steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  max_uses integer,
  uses integer NOT NULL DEFAULT 0,
  expires_at timestamptz,
  bypass_requirements boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS public.club_join_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON UPDATE CASCADE ON DELETE CASCADE,
  steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  message text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  reviewed_by_steam_id bigint REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  UNIQUE (club_id, steam_id)
);

CREATE TABLE IF NOT EXISTS public.club_bans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON UPDATE CASCADE ON DELETE CASCADE,
  steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  banned_by_steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (club_id, steam_id)
);

CREATE TABLE IF NOT EXISTS public.club_activity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON UPDATE CASCADE ON DELETE CASCADE,
  actor_steam_id bigint REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE SET NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS club_activity_club_created_idx
  ON public.club_activity (club_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.club_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON UPDATE CASCADE ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (club_id, slug)
);

CREATE TABLE IF NOT EXISTS public.club_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES public.club_channels(id) ON UPDATE CASCADE ON DELETE CASCADE,
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON UPDATE CASCADE ON DELETE CASCADE,
  author_steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS club_messages_channel_created_idx
  ON public.club_messages (channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.club_leaderboards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON UPDATE CASCADE ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'season' REFERENCES public.e_club_leaderboard_types(value),
  points_win integer NOT NULL DEFAULT 25,
  points_loss integer NOT NULL DEFAULT -15,
  starting_points integer NOT NULL DEFAULT 1000,
  starts_at timestamptz,
  ends_at timestamptz,
  frozen boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.club_leaderboard_entries (
  leaderboard_id uuid NOT NULL REFERENCES public.club_leaderboards(id) ON UPDATE CASCADE ON DELETE CASCADE,
  steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  points integer NOT NULL DEFAULT 1000,
  wins integer NOT NULL DEFAULT 0,
  losses integer NOT NULL DEFAULT 0,
  streak integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (leaderboard_id, steam_id)
);

CREATE TABLE IF NOT EXISTS public.club_queues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON UPDATE CASCADE ON DELETE CASCADE,
  name text NOT NULL,
  region text,
  team_size integer NOT NULL DEFAULT 5,
  min_players integer NOT NULL DEFAULT 10,
  map_pool jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.club_queue_players (
  queue_id uuid NOT NULL REFERENCES public.club_queues(id) ON UPDATE CASCADE ON DELETE CASCADE,
  steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (queue_id, steam_id)
);

CREATE TABLE IF NOT EXISTS public.club_parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON UPDATE CASCADE ON DELETE CASCADE,
  leader_steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  title text NOT NULL DEFAULT '',
  listed boolean NOT NULL DEFAULT false,
  min_elo integer,
  max_elo integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.club_party_members (
  party_id uuid NOT NULL REFERENCES public.club_parties(id) ON UPDATE CASCADE ON DELETE CASCADE,
  steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  is_guest boolean NOT NULL DEFAULT false,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (party_id, steam_id)
);

CREATE TABLE IF NOT EXISTS public.club_clash_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  locked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.club_clash_entries (
  event_id uuid NOT NULL REFERENCES public.club_clash_events(id) ON UPDATE CASCADE ON DELETE CASCADE,
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON UPDATE CASCADE ON DELETE CASCADE,
  points integer NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, club_id)
);

CREATE TABLE IF NOT EXISTS public.club_clash_players (
  event_id uuid NOT NULL REFERENCES public.club_clash_events(id) ON UPDATE CASCADE ON DELETE CASCADE,
  steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON UPDATE CASCADE ON DELETE CASCADE,
  club_id uuid NOT NULL REFERENCES public.clubs(id) ON UPDATE CASCADE ON DELETE CASCADE,
  PRIMARY KEY (event_id, steam_id)
);

-- Helpers / permissions
CREATE OR REPLACE FUNCTION public.is_club_member(p_club uuid, p_steam bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.club_members m
    WHERE m.club_id = p_club AND m.steam_id = p_steam
  );
$$;

CREATE OR REPLACE FUNCTION public.club_member_role(p_club uuid, p_steam bigint)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT m.role FROM public.club_members m
  WHERE m.club_id = p_club AND m.steam_id = p_steam
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.can_manage_club(p_club uuid, p_steam bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.club_members m
    WHERE m.club_id = p_club AND m.steam_id = p_steam
      AND m.role IN ('owner', 'admin')
  );
$$;

CREATE OR REPLACE FUNCTION public.can_moderate_club(p_club uuid, p_steam bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.club_members m
    WHERE m.club_id = p_club AND m.steam_id = p_steam
      AND m.role IN ('owner', 'admin', 'moderator')
  );
$$;

CREATE OR REPLACE FUNCTION public.club_role(club_row public.clubs, hasura_session json)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT public.club_member_role(
    club_row.id,
    NULLIF(hasura_session ->> 'x-hasura-user-id', '')::bigint
  );
$$;

CREATE OR REPLACE FUNCTION public.can_manage_club_cf(club_row public.clubs, hasura_session json)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT public.can_manage_club(
    club_row.id,
    NULLIF(hasura_session ->> 'x-hasura-user-id', '')::bigint
  );
$$;

CREATE OR REPLACE FUNCTION public.slugify_club_name(p_name text)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  s text;
BEGIN
  s := lower(trim(both from p_name));
  s := regexp_replace(s, '[^a-z0-9]+', '-', 'g');
  s := regexp_replace(s, '(^-+|-+$)', '', 'g');
  IF s IS NULL OR s = '' THEN
    s := 'club';
  END IF;
  RETURN left(s, 48);
END;
$$;

DROP TRIGGER IF EXISTS tbi_clubs ON public.clubs;
CREATE OR REPLACE FUNCTION public.tbi_clubs()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  base_slug text;
  candidate text;
  n int := 0;
BEGIN
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    base_slug := public.slugify_club_name(NEW.name);
    candidate := base_slug;
    WHILE EXISTS (SELECT 1 FROM public.clubs c WHERE c.slug = candidate) LOOP
      n := n + 1;
      candidate := base_slug || '-' || n::text;
    END LOOP;
    NEW.slug := candidate;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER tbi_clubs BEFORE INSERT OR UPDATE ON public.clubs
  FOR EACH ROW EXECUTE FUNCTION public.tbi_clubs();

DROP TRIGGER IF EXISTS tai_clubs ON public.clubs;
CREATE OR REPLACE FUNCTION public.tai_clubs_after()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.club_members (club_id, steam_id, role, is_primary)
  VALUES (NEW.id, NEW.owner_steam_id, 'owner', false)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.club_channels (club_id, name, slug)
  VALUES (NEW.id, 'general', 'general')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.club_leaderboards (club_id, name, type, starting_points)
  VALUES (NEW.id, 'All-Time', 'all_time', 1000);

  INSERT INTO public.club_activity (club_id, actor_steam_id, kind, payload)
  VALUES (NEW.id, NEW.owner_steam_id, 'club_created', jsonb_build_object('name', NEW.name));

  RETURN NEW;
END;
$$;
CREATE TRIGGER tai_clubs AFTER INSERT ON public.clubs
  FOR EACH ROW EXECUTE FUNCTION public.tai_clubs_after();

-- Sync primary club flag ↔ players.primary_club_id
CREATE OR REPLACE FUNCTION public.tau_club_members_primary()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.is_primary IS TRUE THEN
    UPDATE public.club_members
    SET is_primary = false
    WHERE steam_id = NEW.steam_id AND club_id <> NEW.club_id AND is_primary IS TRUE;
    UPDATE public.players SET primary_club_id = NEW.club_id WHERE steam_id = NEW.steam_id;
  ELSIF TG_OP = 'DELETE' AND OLD.is_primary IS TRUE THEN
    UPDATE public.players
    SET primary_club_id = NULL
    WHERE steam_id = OLD.steam_id AND primary_club_id = OLD.club_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;
DROP TRIGGER IF EXISTS tau_club_members_primary ON public.club_members;
CREATE TRIGGER tau_club_members_primary
  AFTER INSERT OR UPDATE OF is_primary OR DELETE ON public.club_members
  FOR EACH ROW EXECUTE FUNCTION public.tau_club_members_primary();

INSERT INTO public.settings (name, value)
VALUES ('public.clubs_queues_enabled', 'false')
ON CONFLICT (name) DO NOTHING;
