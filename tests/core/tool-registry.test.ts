import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/core/tool-registry.js";

describe("ToolRegistry", () => {
  it("rejects duplicate and invalid names", () => {
    const registry = new ToolRegistry();
    const tool = {
      name: "demo.echo",
      description: "Echo input",
      inputSchema: { type: "object" as const },
      execute: async () => ({ ok: true }),
    };
    registry.register(tool);
    expect(() => registry.register(tool)).toThrow(/duplicate/);
    expect(() => registry.register({ ...tool, name: "bad name" })).toThrow(
      /invalid/,
    );
  });

  it("lists tools deterministically and calls by name", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "z.echo",
      description: "Echo input",
      inputSchema: { type: "object" },
      execute: async (input) => input,
    });
    registry.register({
      name: "a.ready",
      description: "Return readiness",
      inputSchema: { type: "object" },
      effect: "read",
      execute: async () => ({ ready: true }),
    });
    expect(registry.list().map((tool) => tool.name)).toEqual([
      "a.ready",
      "z.echo",
    ]);
    expect(
      registry.list().find((tool) => tool.name === "a.ready")?.effect,
    ).toBe("read");
    await expect(
      registry.call(
        "a.ready",
        {},
        { runId: "run-1", signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ ready: true });
    await expect(
      registry.call(
        "missing",
        {},
        { runId: "run-1", signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/unknown tool/);
  });
});
