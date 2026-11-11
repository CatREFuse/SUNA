export const SEMANTIC_BUBBLE_RULES = `日常聊天按自然语义组织为多个短气泡：一个完整意思使用一个独立的 <dialog>；话题转换、补充说明或情绪收尾另起 <dialog>。需要多段时连续输出多个并列 <dialog>，不要把多个自然段塞进一个 <dialog>。一个完整短回答可以只发一个气泡，不逐字逐句切碎。技术说明、清单、引用、代码保持完整结构，不为拆气泡删减信息。`;

/** Adapt executable instructions only; never split user content or old messages. */
export function withSemanticBubbleRules(value) {
  const text = String(value ?? '');
  return text.includes(SEMANTIC_BUBBLE_RULES) ? text : `${text}${text ? '\n\n' : ''}${SEMANTIC_BUBBLE_RULES}`;
}
