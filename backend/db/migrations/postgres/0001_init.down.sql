-- 0001_init · 回滚（PostgreSQL）
--
-- 顺序与外键依赖相反：先删引用方，再删被引用方。
-- 生产环境的回滚手段是「恢复备份」而不是跑 down（见 docs/07 §6.2），
-- 本文件主要供开发环境与 parity 校验使用。

DROP TABLE IF EXISTS map_revisions;
DROP TABLE IF EXISTS share_links;
DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS files;
DROP TABLE IF EXISTS user_devices;
DROP TABLE IF EXISTS user_tokens;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS themes;
DROP TABLE IF EXISTS templates;
DROP TABLE IF EXISTS maps;
DROP TABLE IF EXISTS users;

-- 扩展不删：同库可能还有其它使用者，且重建代价高于留着。
-- DROP EXTENSION IF EXISTS pg_trgm;
