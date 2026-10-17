package config

// Version 是构建版本号，通过 -ldflags "-X .../internal/config.Version=v1.2.3"
// 注入；未注入时是 "dev"。
//
// 它会被 GET /site/config 返回，前端据此判断「后端是否换了版本、要不要提示
// 刷新页面」。用变量而不是常量，就是为了让链接器能改它。
var Version = "dev"
