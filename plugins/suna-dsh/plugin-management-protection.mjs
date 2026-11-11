/** Protect SUNA's public service composition and the Agent factory; optional native tool providers remain manageable. */
export function createDshRequiredEntries(ctx, {moduleNames = []} = {}) {
  const modules = new Set(['@deepseek-ai/dsh-agent-loop', ...moduleNames]);
  return () => {
    const protectedIds = new Set(), fibers = new Set();
    const addFiber = fiber => {
      if (!fiber || fibers.has(fiber)) return;
      fibers.add(fiber);
      const id = ctx.loader.locate(fiber);
      if (id) protectedIds.add(id);
      // Service.ctx is traced to its caller. The public committed bindings retain
      // the actual providers, including class inheritance and scoped injections.
      for (const implementation of Object.values(fiber.committed ?? {})) addFiber(implementation?.ctx?.fiber);
    };
    // The management injection inherits SUNA Bridge's required service graph.
    let ancestor = ctx.fiber;
    while (ancestor) {
      addFiber(ancestor);
      const parent = ancestor.parent?.fiber;
      if (parent === ancestor) break;
      ancestor = parent;
    }
    for (const entry of ctx.loader.entries()) if (modules.has(entry.options.name)) addFiber(entry.fiber);
    return protectedIds;
  };
}
