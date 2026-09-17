DROP TABLE IF EXISTS public.store_vip_grants;
DELETE FROM public.e_notification_types
WHERE value IN ('StorePurchasePaid', 'StorePurchaseCancelled');
