/** Display-only attachment helpers; upload and draft ownership stay in the caller. */
export function attachmentSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export function composerPreviewUrl(value, origin) {
  if (typeof value !== 'string' || !value) return '';
  if (/^blob:/i.test(value)) return value;
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z\d+/=\s]+$/i.test(value)) return value;
  try {
    const url = new URL(value, origin);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === origin ? url.href : '';
  } catch { return ''; }
}

export function composerMenuIndex(current, key, enabled) {
  if (!enabled.length) return -1;
  if (key === 'Home') return enabled[0];
  if (key === 'End') return enabled.at(-1);
  const index = enabled.indexOf(current), step = key === 'ArrowUp' ? -1 : 1;
  return enabled[(index + step + enabled.length) % enabled.length];
}
