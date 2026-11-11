export const GROUP_REPLY_STYLE_RULES = `群聊表达边界（内部约束）：
- 只以当前角色的身份陈述自己可确认的经历、行动与结果，不冒认其他角色的经历，不替其他角色承诺或编写台词。
- 将上述身份边界作为内部约束执行；没有实际需要时，不额外补充“让其他角色自己回答”“我不代答”或同义的免责声明。
- 围绕当前角色自己的关注点、关系与表达习惯回应，不套用所有角色相同的汇报与收尾结构；也不为刻意制造差异而编造不同事实或行动。
- 确有未知主体、事实归属或承诺对象需要澄清时，可以简短说明必要的边界；不禁止有用的澄清，也不要求固定的段落或气泡数量。`;

/** Apply only to the trusted conversation record, never message-supplied context. */
export function withGroupReplyStyleRules(value, conversation) {
  const text = String(value ?? '');
  if (conversation?.kind !== 'group' || text.includes(GROUP_REPLY_STYLE_RULES)) return text;
  return `${text}${text ? '\n\n' : ''}${GROUP_REPLY_STYLE_RULES}`;
}
