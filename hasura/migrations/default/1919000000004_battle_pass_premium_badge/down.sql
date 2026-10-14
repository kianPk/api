DELETE FROM public.award_recipients
 WHERE award_id IN (
   SELECT id FROM public.awards WHERE system_key LIKE 'battle_pass_s%_premium'
 );

DELETE FROM public.awards
 WHERE system_key LIKE 'battle_pass_s%_premium';
