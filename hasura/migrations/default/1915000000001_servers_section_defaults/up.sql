INSERT INTO public.settings (name, value)
VALUES
    ('servers_section_duels', '1'),
    ('servers_section_awp', '1'),
    ('servers_section_2x2', '1')
ON CONFLICT (name) DO NOTHING;
