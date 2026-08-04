UPDATE template_versions
SET status = 'retired'
WHERE template_key = 'home-services' AND status = 'active';

INSERT INTO template_versions (id, template_key, version, schema_version, status, created_at)
VALUES ('tpl-home-services-v2', 'home-services', 2, 1, 'active', datetime('now'));
