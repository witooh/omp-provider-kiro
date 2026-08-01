// `vi` in bun:test is an alias of `jest`: it has fn/spyOn/mock but no
// global-stubbing API and no `mocked` type helper. Re-export it with the three
// vitest members this suite relies on.

import { vi as bunVi, type Mock } from "bun:test";

const globals = globalThis as unknown as Record<string, unknown>;
const stubbedGlobals = new Map<string, { existed: boolean; previous: unknown }>();

export const vi: typeof bunVi & {
  stubGlobal(name: string, value: unknown): void;
  unstubAllGlobals(): void;
  mocked<T extends (...args: never[]) => unknown>(value: T): Mock<T>;
} = Object.assign(bunVi, {
  stubGlobal(name: string, value: unknown): void {
    if (!stubbedGlobals.has(name)) stubbedGlobals.set(name, { existed: name in globals, previous: globals[name] });
    globals[name] = value;
  },

  unstubAllGlobals(): void {
    for (const [name, { existed, previous }] of stubbedGlobals) {
      if (existed) globals[name] = previous;
      else delete globals[name];
    }
    stubbedGlobals.clear();
  },

  // vitest's `mocked` is a compile-time cast; at runtime it returns its argument.
  mocked<T extends (...args: never[]) => unknown>(value: T): Mock<T> {
    return value as unknown as Mock<T>;
  },
});
