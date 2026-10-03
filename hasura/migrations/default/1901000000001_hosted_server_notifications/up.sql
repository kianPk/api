INSERT INTO public.e_notification_types ("value", "description") VALUES
  ('HostedServerReady', 'A rented server was created or renewed'),
  ('HostedServerExpiring', 'A rented server expires soon'),
  ('HostedServerExpired', 'A rented server expired and was stopped'),
  ('HostedServerFailed', 'A rented server could not be provisioned')
ON CONFLICT ("value") DO UPDATE
  SET "description" = EXCLUDED."description";
