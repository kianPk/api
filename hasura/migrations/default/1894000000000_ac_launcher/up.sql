-- YGuard Anti-Cheat launcher attestations (client hardware checks)

CREATE TABLE IF NOT EXISTS public.ac_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON DELETE CASCADE,
  device_token_hash text NOT NULL UNIQUE,
  label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS ac_devices_steam_id_idx ON public.ac_devices (steam_id)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS public.ac_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  steam_id bigint NOT NULL REFERENCES public.players(steam_id) ON DELETE CASCADE,
  device_id uuid REFERENCES public.ac_devices(id) ON DELETE SET NULL,
  secure_boot boolean NOT NULL DEFAULT false,
  iommu boolean NOT NULL DEFAULT false,
  tpm_20 boolean NOT NULL DEFAULT false,
  tpm_attestation boolean NOT NULL DEFAULT false,
  hvci boolean NOT NULL DEFAULT false,
  windows_updates boolean NOT NULL DEFAULT false,
  os_version text,
  hardware_hash text,
  passed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS ac_attestations_steam_valid_idx
  ON public.ac_attestations (steam_id, expires_at DESC)
  WHERE passed = true;

CREATE TABLE IF NOT EXISTS public.ac_pair_codes (
  code text PRIMARY KEY,
  steam_id bigint REFERENCES public.players(steam_id) ON DELETE CASCADE,
  device_token_hash text,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.settings (name, value) VALUES
  ('public.ac_launcher_required', 'false'),
  ('public.ac_attestation_ttl_minutes', '15'),
  ('public.ac_require_secure_boot', 'true'),
  ('public.ac_require_tpm', 'true'),
  ('public.ac_require_hvci', 'false'),
  ('public.ac_require_iommu', 'false'),
  ('public.ac_require_windows_updates', 'false')
ON CONFLICT (name) DO NOTHING;
