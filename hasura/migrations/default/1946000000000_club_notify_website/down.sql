ALTER TABLE public.clubs DROP CONSTRAINT IF EXISTS clubs_website_url_len;
ALTER TABLE public.clubs DROP COLUMN IF EXISTS website_url;

DELETE FROM public.e_notification_types
 WHERE value IN (
   'ClubChallengeActivated',
   'ClubNewsPosted',
   'ClubTournamentCreated'
 );
