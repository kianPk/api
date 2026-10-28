-- Club in-app notification types + optional website on club socials.

INSERT INTO e_notification_types ("value", "description") VALUES
  ('ClubChallengeActivated', 'A club challenge became available for you'),
  ('ClubNewsPosted', 'Your club posted news'),
  ('ClubTournamentCreated', 'Your club opened a tournament')
ON CONFLICT ("value") DO UPDATE
  SET "description" = EXCLUDED."description";

ALTER TABLE public.clubs
  ADD COLUMN IF NOT EXISTS website_url text;

ALTER TABLE public.clubs
  DROP CONSTRAINT IF EXISTS clubs_website_url_len;
ALTER TABLE public.clubs
  ADD CONSTRAINT clubs_website_url_len
  CHECK (website_url IS NULL OR char_length(website_url) BETWEEN 8 AND 200);

COMMENT ON COLUMN public.clubs.website_url IS
  'Optional club website URL shown with social links.';
