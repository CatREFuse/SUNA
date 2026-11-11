/** Message sender avatars are projected by the server, never arbitrary URLs. */
export function localSenderAvatar(value) {
  return typeof value==='string' && /^\/api\/conversations\/[a-zA-Z0-9_-]+\/messages\/[a-zA-Z0-9_-]+\/avatar$/.test(value) ? value : '';
}
