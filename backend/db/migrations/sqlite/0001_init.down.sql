-- 0001_init · 回滚（SQLite）
--
-- 与外键依赖相反的顺序删除。
--
-- ⚠️ 若连接开启了 foreign_keys（本项目在连接初始化里强制开启，见 docs/03 §3.4.1），
--    删除顺序错误会直接报 FOREIGN KEY constraint failed。顺序不能随意调换。

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
