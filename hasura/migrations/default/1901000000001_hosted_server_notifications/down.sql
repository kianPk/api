DELETE FROM public.e_notification_types
  WHERE "value" IN ('HostedServerReady', 'HostedServerExpiring', 'HostedServerExpired', 'HostedServerFailed');
