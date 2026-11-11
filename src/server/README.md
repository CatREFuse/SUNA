# 沙之书本地 HTTP 服务

```js
const app = await createBookServer({ projectRoot, dataDir, port: 0 });
// app.url, app.port, app.book, app.runtime, app.channelRouter
await app.close();
```

只绑定 `127.0.0.1`；默认端口 4261。生产页面由 `dist` 提供，开发服务使用 `development:true` 接受 Vite 4260 的同机代理。不同 Origin、跨站 Fetch、伪造 Host 和非本机连接均被拒绝。

先 GET `/api/bootstrap` 取得 `csrfToken`，所有写请求携带 `x-sandbook-csrf`。平台 Webhook 独立由已安装插件验证签名/Token，不使用浏览器 CSRF；浏览器 Origin 不能调用 Webhook。JSON 请求默认最多 4 MB，插件 ZIP 的 Base64 最多 12 MB，素材最多 160 MB 原始数据。

## UI 协议

以下路径均加 `/api` 前缀；未注明方法的动作使用 POST JSON。

| 范围 | 路径与返回 |
| --- | --- |
| 状态 | GET `/bootstrap`、`/snapshot`、`/settings`；GET `/events` 为 SSE，仅广播变化标记 |
| 设置 | PATCH `/settings`，可携带 `expectedVersion`，冲突为 409 |
| 角色 | `/characters`；PATCH `/characters/:id` |
| 对话 | `/conversations`；PATCH `/conversations/:id`；`/conversations/:id/participants` `{ids}`；`messages` `{text,requestId?,mentionIds?}`；`cancel` `{}` |
| 提示词 | `/prompts/draft`、`publish`、`preview`、`history`、`rollback`；GET `/prompts/export`；`/prompts/import` `{envelope,preview?,expectedVersion?}` |
| DSH | GET `/runtime/status`、`model`、`updates`、`plugin`；`start`、`stop`、`gui`、`model`、`update`、`external`、`bundled`、`install-plugin` |
| 渠道 | GET `/channels` → `{plugins,connections}`；`/channels/import` `{name,data}`；`/channels/accounts` `{pluginId,characterId,config,accountId?}`；PATCH / DELETE `/channels/accounts/:id`；`connect` / `disconnect` / `qr` / `poll` 子路径 |
| 素材 | `/assets/import` `{name,data,columns?,rows?,fps?}`，返回可直接保存为角色 `pet` 的对象；GET `/assets-local/...` 只通过素材存储的真实路径校验后服务 |
| 开发者 | GET `/developer/logs` 返回含 `time` 的数组；GET `/developer/diagnostics`；GET / POST `/developer/tests`；GET / DELETE `/developer/tests/:id`；`/developer/tests/:id/run` `{input,worker?}`；`cancel` `{}` |

`/runtime/updates` 同时返回适配器原字段和 UI 字段 `updateAvailable/latestVersion`。`/runtime/gui` 返回 `{url}`。`/runtime/plugin` 下载可安装的 DSH 桥接插件 ZIP。

渠道配置中密钥仅写入 `dataDir/channels/accounts.json`，文件模式 0600。列表返回 `config` 的非密钥字段和 `configuredSecrets` 名称，不回传值。编辑时省略密钥表示保留。显式连接会保存 `autoConnect:true` 以在重启时恢复收件连接；断开连接关闭此标记。二维码确认后调用真正的连接方法，返回 `connectionStatus`。

群聊按 `manifest.platform + group ID` 合并，多账号分别绑定角色。QQ 开放平台的 OpenID 与普通 QQ 号码使用不同 platform 命名空间。重复平台消息只落库一次，每个接收角色独立消费；出站选择当前角色在该平台绑定的账号。接口和测试不会主动向任何真实外部账号发送消息。

## 桌面进程协议

CLI 使用环境变量：`SAND_PROJECT_ROOT`、`SAND_DATA_DIR`、`SAND_RUNTIME_DIR`、`SAND_PLUGIN_DIR`、`SAND_UI_DIR`、`SAND_PORT`、`SAND_DEVELOPMENT`。

启动成功通过 IPC 发出 `{type:'ready',url,port,nativeHeaders}`。`nativeHeaders` 仅交给 Electron 主进程，不能注入 renderer；包含 CSRF 和 `x-sandbook-native` 凭证。接收 `{type:'shutdown'}`、SIGTERM 和 SIGINT 后立即停止接收 HTTP 和渠道事件，关闭慢上传连接，取消运行，并等待进行中请求、数据库和 runtime.close 完成。重复关闭共享同一个完成 Promise。

桌面文件选择器可用 `/assets/import` `{path}` 和 `/channels/import` `{path}`，必须带 native 凭证。用户在设置中输入 DSH_HOME 时，安装只运行受信任的内置 DSH CLI；指定可执行程序、CLI 路径、包路径或包管理器时必须使用 native 凭证。`/runtime/connect` 是 `/runtime/external` 的桌面别名。

## 验证

`tests/server.test.mjs` 使用真实本机 HTTP、SQLite 和业务服务，模型/渠道为隔离替身。共 10 项验证 Origin/Host/CSRF、静态路径与本机文件边界、版本冲突、开发者门控、配置私密保存、QR 会话、多账号群聊分发、SSE、重启恢复、关闭时晚到事件/上传门控及凭据字面值遮蔽。沙盒环境需要允许绑定临时 loopback 端口。运行时、真实账号连通与桌面交互证据由各自专项测试提供。
