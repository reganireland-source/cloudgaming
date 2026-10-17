-- How a local PC is streamed by default: 'mirror' (its own screens stay on, desktop
-- shown on the receiver) or 'headless' (its screens off, a virtual display at the
-- receiver's size). Chosen per launch; this is the saved default.
ALTER TABLE local_machines ADD COLUMN IF NOT EXISTS display_mode VARCHAR(10) NOT NULL DEFAULT 'mirror';
