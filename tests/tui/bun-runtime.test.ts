import { describe, expect, it } from "vitest";
import {
  findBunBinary,
  shouldRelaunchTuiWithBun,
} from "../../src/tui/bun-runtime.js";

describe("Bun OpenTUI runtime selection", () => {
  it("prefers an explicit Bun path and requires an interactive TTY by default", () => {
    const env = {
      TMSH_BUN_PATH: "C:\\tools\\bun.exe",
      PATH: "C:\\Windows",
    };
    expect(findBunBinary(env, "win32", (path) => path.includes("tools"))).toBe(
      "C:\\tools\\bun.exe",
    );
    expect(
      shouldRelaunchTuiWithBun({
        env,
        stdinTty: true,
        stdoutTty: true,
        bunRuntime: false,
      }),
    ).toBe(true);
    expect(
      shouldRelaunchTuiWithBun({
        env,
        stdinTty: false,
        stdoutTty: true,
        bunRuntime: false,
      }),
    ).toBe(false);
  });

  it("does not recurse inside Bun and supports a forced smoke run", () => {
    expect(
      shouldRelaunchTuiWithBun({
        env: { TMSH_FORCE_NATIVE_TUI: "1" },
        stdinTty: false,
        stdoutTty: false,
        bunRuntime: false,
      }),
    ).toBe(true);
    expect(
      shouldRelaunchTuiWithBun({
        env: { TMSH_FORCE_NATIVE_TUI: "1" },
        stdinTty: true,
        stdoutTty: true,
        bunRuntime: true,
      }),
    ).toBe(false);
  });
});
