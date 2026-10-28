-- Optional add-ons chosen when a machine was launched: [{ "id": "godot", "options": { ... } }]
ALTER TABLE machines ADD COLUMN IF NOT EXISTS addons JSONB NOT NULL DEFAULT '[]';
