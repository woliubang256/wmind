CREATE INDEX idx_maps_trash_retention ON maps (deleted_at, id) WHERE deleted_at IS NOT NULL;
