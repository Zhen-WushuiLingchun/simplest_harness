import { describe, expect, it } from "vitest";
import {
  repairDoubleEncodedToolInput,
  toolAliases,
} from "../../src/models/adapter.js";
import type { ToolSummary } from "../../src/core/tool-registry.js";

describe("provider tool aliases", () => {
  it("maps dotted and unusual canonical names to stable provider-safe names without collisions", () => {
    const tools: ToolSummary[] = [
      {
        name: "model.list",
        description: "one",
        inputSchema: { type: "object" },
        effect: "read",
      },
      {
        name: "model_list",
        description: "two",
        inputSchema: { type: "object" },
        effect: "read",
      },
      {
        name: "mcp.server/tool",
        description: "three",
        inputSchema: { type: "object" },
        effect: "external",
      },
    ];
    const aliases = toolAliases(tools);
    const providerNames = tools.map((tool) =>
      aliases.canonicalToProvider.get(tool.name)!,
    );
    expect(new Set(providerNames).size).toBe(tools.length);
    expect(providerNames.every((name) => /^[A-Za-z0-9_-]+$/u.test(name))).toBe(
      true,
    );
    for (const tool of tools) {
      const alias = aliases.canonicalToProvider.get(tool.name)!;
      expect(aliases.providerToCanonical.get(alias)).toBe(tool.name);
    }
  });

  it("repairs only double-encoded JSON tool objects", () => {
    const object = {
      args: ["-c", "grep -n test file.go"],
      cwd: "/app",
      file: "/bin/sh",
    };
    const repaired = repairDoubleEncodedToolInput(
      JSON.stringify(JSON.stringify(object)),
    );

    expect(repaired).toBe(JSON.stringify(object));
    expect(
      repairDoubleEncodedToolInput(JSON.stringify(object)),
    ).toBeUndefined();
    expect(
      repairDoubleEncodedToolInput(JSON.stringify("plain text")),
    ).toBeUndefined();
    expect(repairDoubleEncodedToolInput("not json")).toBeUndefined();
  });
});
