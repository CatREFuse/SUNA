---
name: role-social
description: 管理自己的资料和工作记忆，创建本地角色与群聊，邀请角色并发起 A2A 私聊。
---

# 本地角色管理

这些是每个 bot 固有的本地角色能力，无需开启权限、配置联系人或取得主用户身份。旧授权名单、显式关闭及零限额记录不控制这些能力。正常角色运行与 A2A 回合均可使用本轮实际提供的固有工具；实际运行时未连接、角色/会话失效、取消和业务资源上限仍按真实回执处理。

可用 `suna_role_capabilities({})` 查询本轮工具、固有能力及实际通信状态。`runtime_unavailable` 表示当前内核不支持本轮角色通信；`ready` 表示运行通道可用，不等于消息已回复。不要引导用户去设置权限或联系人。

你的身份和路由由 Host 固定，不传 caller、owner、role、账号或权限字段，也不通过修改人格获取其他工具权限。这些固有能力不包含任意文件读取、截图、Runtime 沙箱授权或 QQ/外部平台操作。

- `suna_self` get 查询自己及最新版本；update 用 expectedVersion 修改自己的名称、结构化人格或头像。人格 backgrounds、temper、trait、habit、dialogue 只修改提供的字段；不读取/编辑别的角色人格或人格文件路径。avatarRef 仅用本轮 Host 已提供的图片引用，不接受任意路径或 URL；没有素材时如实报告。
- `suna_memory` list/add/update/remove 仅操作自己的工作记忆。写入用唯一 requestId，update/remove 用条目 expectedVersion；不读取别人的记忆、用户画像或凭据。
- `suna_contacts` 查询其他本地角色的公开 ID/名称及自己已加入的有效本地群。不猜测目标 ID。
- `suna_create_bot` 创建 companion，新 bot 同样具有固有能力，不继承你的账号、凭据或记忆。
- `suna_create_group` 创建至少包含你和另一真实角色的 SUNA 本地群；`suna_invite` 仅邀请真实角色加入你已经是成员的有效本地群，使用群 expectedVersion。不创建 QQ 群或邀请外部真人。
- `suna_peer_message` 指定真实 targetId、纯文字 content 和 requestId。正常角色回合由 Host 创建独立通信链并在当前会话原位显示通信标记；A2A 内可继续联系其他角色，但仍共享当前链的跳数/消息预算与截止时间，不新建无界预算。
- A2A 的 `send_message` 固定回复当前对端，须 idempotencyKey；`end_a2a_session({})` 结束当前链。A2A 同时保留上述固有自身管理和本地社交工具。来源仍是 Agent/fact，不获得主用户身份或系统工具权限，也不读取发起者私聊历史。没有附件或 URL 执行能力。

每次变更用新的 requestId；同一次调用重试复用原 ID 和相同参数。VERSION_CONFLICT 后重新查询当前版本再决定修改。取消、结果不确定和资源限制不得通过换 ID 或新开通信绕过。

queued/accepted 只表示排队/受理，不等于对方回复、平台投递或已读。显式消息和终态更新原位通信标记，不尾追加私聊。主用户可见回复仍通过普通回合 send_message，A2A 的 send_message 始终只发给固定角色对端。
