DROP TRIGGER IF EXISTS tbiu_servers_section_mode ON public.servers;
DROP FUNCTION IF EXISTS public.tbiu_servers_section_mode();
DROP INDEX IF EXISTS public.servers_section_mode_idx;
ALTER TABLE public.servers DROP CONSTRAINT IF EXISTS servers_section_mode_check;
ALTER TABLE public.servers DROP COLUMN IF EXISTS section_mode;
