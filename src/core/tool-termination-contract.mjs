// Model-facing facts about the existing tool configuration. These helpers do
// not decide whether a task is complete or change any execution/receipt policy.
function rule(name, terminate, perCallTermination = false) {
  if (name === 'send_message' && perCallTermination === true) {
    const fallback = terminate === true ? '当前配置默认结束本轮' : terminate === false ? '当前配置默认继续处理' : terminate === 'dynamic' ? '当前配置由真实工具回执动态决定' : '使用本轮工具配置与运行时默认值';
    return `由你判断当前任务是否已完成：已完成所需工具及真实结果核对、准备发送最终回复时，显式传 terminate:true；只发送进度或仍需继续调用工具时，显式传 terminate:false，发送后继续处理。省略 terminate 时沿用配置默认值（${fallback}）。不得把操作预告当作任务完成；普通模型 final 文本不会公开送达用户，公开回复仍须通过 send_message 发送。`;
  }
  if (terminate === true) {
    if (name === 'send_message') return '当前配置默认结束本轮；若真实工具回执显式声明终止或继续，则以回执为准。先完成所需工具及结果核对，再发送最终回复，不要只预告尚未执行的操作。普通模型 final 文本不会公开送达用户，最终回复仍须通过 send_message 发送。';
    return '本工具配置默认终止；成功调用且真实回执未另行声明时结束本轮。若真实工具回执显式声明终止或继续，则以回执为准，不要预期工具调用后自动开启下一轮。';
  }
  if (terminate === false) return '本工具配置默认继续处理，本次调用默认不要求结束本轮；若真实工具回执显式声明终止或继续，则以回执为准。根据真实回执继续完成尚未完成的工作。';
  if (terminate === 'dynamic') return '本工具是否结束本轮由本次真实工具回执动态决定；提交受理不等于任务完成，不要预设一定继续或一定结束。';
  return '';
}

export function toolTerminationDescription({name, description = '', terminate, perCallTermination = false} = {}) {
  const original = typeof description === 'string' ? description : '';
  const contract = rule(name, terminate, perCallTermination);
  return contract ? `${original}${original ? '\n\n' : ''}结束语义：${contract}` : original;
}

export function toolTerminationSystemRules(tools = []) {
  if (!Array.isArray(tools)) return '';
  const entries = tools.flatMap(tool => {
    if (!tool || typeof tool.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.:-]{0,199}$/u.test(tool.name)) return [];
    const contract = rule(tool.name, tool.terminate, tool.perCallTermination);
    return contract ? [`${tool.name}：${contract}`] : [];
  });
  return entries.length ? `工具结束语义（以本轮实际配置与真实回执为准）：\n${entries.join('\n')}` : '';
}
