// system-tasks — dispatch-on-create maintenance jobs.
//
// Live slot: `effects` (run the task post-commit). Other registries:
//   patterns/writePolicy → schema.ts (_system_tasks DDL) + policy.ts
//   routes               → src/index.ts (/dev/seed-vectors triggers the task path)

import type { Feature } from "../feature";

export const systemTasks: Feature = {
  name: "system-tasks",
  effects: {
    _system_tasks: {
      async after(entry, result, parsed, operation, scratch, ctx) {
        if (operation === "create" && entry) await ctx.runTask(entry.id, entry.task);
      },
    },
  },
};
