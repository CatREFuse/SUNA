/** Wait at the public pre-step waterfall, preserving its already-claimed messages and normal next() semantics. */
export function installDshManagementAgentBarrier(ctx, management) {
  ctx.on('agent/pre-step', async (payload, next) => {
    await management.waitForIdle(payload.signal);
    return next();
  });
}
