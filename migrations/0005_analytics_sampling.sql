ALTER TABLE daily_domain_metrics ADD COLUMN max_sample_interval INTEGER NOT NULL DEFAULT 1;
ALTER TABLE analytics_rollup_runs ADD COLUMN max_sample_interval INTEGER NOT NULL DEFAULT 1;
