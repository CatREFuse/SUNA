const messages = Object.freeze({
  DSH_PLUGIN_NATIVE_REQUIRED: '请在桌面端管理 DSH 插件',
  DSH_PLUGIN_TARGET_CHANGED: 'DSH 连接已变化，请刷新',
  DSH_PLUGIN_CONFLICT: '配置已更新，请刷新后提交',
  DSH_PLUGIN_PROTECTED: '此插件由运行时管理',
  DSH_PLUGIN_UNSUPPORTED: '当前 DSH 不支持此操作',
  DSH_PLUGIN_DISCONNECTED: 'DSH 未连接',
  DSH_PLUGIN_OPERATION_UNKNOWN: '操作结果待确认',
  DSH_PLUGIN_SCHEMA_UNSUPPORTED: '此配置暂不支持编辑',
  DSH_PLUGIN_SECRET_STRUCTURE: '请分别修改现有条目中的凭证',
  DSH_PLUGIN_INPUT_INVALID: '请检查填写内容',
  DSH_PLUGIN_METHOD_UNSUPPORTED: '不支持此操作',
  DSH_PLUGIN_PROFILE_INVALID: '插件配置无法应用',
  DSH_PLUGIN_PROFILE_WRITE_FAILED: '插件配置保存失败',
  DSH_PLUGIN_BUILD_APPROVAL_REQUIRED: '此插件需要构建脚本授权',
  DSH_PLUGIN_BUSY: '插件管理操作正在处理中',
  DSH_PLUGIN_RECEIPT_CAPACITY: '操作记录空间已满',
  DSH_PLUGIN_RECEIPT_READ_ONLY: '请查询原操作记录',
  DSH_PLUGIN_INSPECTION_EXPIRED: '安装检查已过期，请重新检查',
  DSH_PLUGIN_PACKAGE_INVALID: '插件包无效或完整性校验失败',
  DSH_PLUGIN_INCOMPATIBLE: '插件与当前 DSH 版本不兼容',
  DSH_PLUGIN_RESTART_REQUIRED: '请重启 DSH 后删除此插件',
  DSH_PLUGIN_PACKAGE_FAILED: '插件包操作失败',
});

/** Arbitrary upstream messages, diagnostics, package output and file paths never cross the UI boundary. */
export function safeDshManagementError(error) {
  const code = Object.hasOwn(messages, error?.code) ? error.code : 'DSH_PLUGIN_OPERATION_UNKNOWN';
  return {code, message: messages[code]};
}

export function managementFailure(code) {
  const safe = safeDshManagementError({code});
  return Object.assign(new Error(safe.message), {code: safe.code});
}
