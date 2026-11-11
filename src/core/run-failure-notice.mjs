// Public notices contain only fixed text and bounded recovery metadata. Never
// interpolate provider messages, tool arguments, URLs, credentials or stacks.
export function runFailureState(error, signal) {
  const reason = signal?.aborted ? signal.reason : undefined;
  const failure = reason ?? error;
  const code = typeof failure?.code === 'string' ? failure.code : undefined;
  if (code === 'RUN_CANCELLED') {
    const cancelSource = ['user', 'shutdown', 'policy', 'revocation'].includes(failure.cancelSource) ? failure.cancelSource : 'runtime';
    if (cancelSource === 'user' && failure.cancelReason === 'USER_STOP') return {status: 'cancelled', code, cancelSource, cancelReason: 'USER_STOP'};
    return {status: 'failed', code: {shutdown: 'RUN_SHUTDOWN', policy: 'RUN_POLICY_CHANGED', revocation: 'RUN_PERMISSION_REVOKED'}[cancelSource] ?? 'RUN_INTERRUPTED', cancelSource};
  }
  if (code === 'RUN_TIMEOUT') return {status: 'failed', code};
  if (failure?.name === 'AbortError' || failure?.code === 20) return {status: 'failed', code: 'MODEL_ABORTED'};
  return {status: 'failed', code: code ?? 'RUNTIME_ERROR'};
}

export function runFailureNotice(error, code) {
  const cause = error?.recovery?.causeCode ?? code;
  const retryCount = error?.recovery?.retryCount;
  const maxRetries = error?.recovery?.maxRetries;
  const retried = Number.isSafeInteger(retryCount) && retryCount > 0 && Number.isSafeInteger(maxRetries) && maxRetries >= retryCount && maxRetries <= 10
    ? `，重试 ${retryCount} 次后仍未成功` : code === 'MODEL_RETRY_EXHAUSTED' ? '，重试后仍未成功' : '';
  let text;
  if (cause === 'AUTH_REQUIRED') text = '模型凭据验证失败，请检查模型服务配置。';
  else if (cause === 'INSUFFICIENT_BALANCE') text = '模型账户余额或额度不足，请检查模型服务账户。';
  else if (code === 'RUNTIME_UNAVAILABLE') text = '尚未连接运行环境，无法生成回复。';
  else if (['RUN_INPUT_TOO_LARGE','INPUT_CONTEXT_TOO_LARGE'].includes(cause)) text = '本轮消息或必要规则超过模型输入限制，请减少内容后重试。';
  else if (cause === 'MESSAGE_IMAGES_TOO_LARGE') text = '本轮图片超过模型输入限制，请减少图片数量或尺寸后重试。';
  else if (cause === 'MESSAGE_IMAGE_UNAVAILABLE') text = '本轮图片无法安全读取。';
  else if (cause === 'model.images.unsupported') text = '当前模型不支持本轮图片输入，请更换支持图片的模型。';
  else if (code === 'NO_VISIBLE_OUTPUT') text = '模型未能发送回复，请稍后重试。';
  else if (code === 'RUN_TIMEOUT' || ['TIMEOUT', 'MODEL_ABORTED'].includes(cause)) text = `模型请求超时或中断${retried}，未能完成回复。请稍后重试。`;
  else text = `模型请求失败${retried}，未能完成回复。请稍后重试。`;
  return `系统错误：${text}`;
}
