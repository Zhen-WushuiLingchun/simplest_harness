import { describe, expect, it } from "vitest";
import { ProcessManager } from "../../src/tools/process-manager.js";

const cwd = process.cwd();

describe("ProcessManager", () => {
  it("runs a foreground command and observes its exit", async () => {
    const manager = new ProcessManager();
    const result = await manager.start({
      file: process.execPath,
      args: ["-e", "process.stdout.write('ok'); process.stderr.write('warn')"],
      cwd,
      background: false,
      timeoutMs: 5_000,
      yieldMs: 5_000,
      maxOutputBytes: 10_000,
    });
    expect(result.status).toBe("exited");
    expect(result.exitCode).toBe(0);
    expect(result.output.map((item) => [item.channel, item.text])).toEqual([
      ["stdout", "ok"],
      ["stderr", "warn"],
    ]);
  });

  it("starts in the background, waits, and supports stdin", async () => {
    const manager = new ProcessManager();
    const started = await manager.start({
      file: process.execPath,
      args: [
        "-e",
        "process.stdin.once('data', d => { process.stdout.write(d); process.exit(0) })",
      ],
      cwd,
      background: true,
      timeoutMs: 5_000,
      yieldMs: 0,
      maxOutputBytes: 10_000,
    });
    expect(started.status).toBe("running");
    manager.writeStdin(started.processId, "hello", true);
    const done = await manager.wait({
      processId: started.processId,
      cursor: 0,
      yieldMs: 5_000,
    });
    expect(done.status).toBe("exited");
    expect(done.output.map((item) => item.text).join("")).toBe("hello");
  });

  it("times out and stops a long process", async () => {
    const manager = new ProcessManager();
    const started = await manager.start({
      file: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd,
      background: true,
      timeoutMs: 30,
      yieldMs: 0,
      maxOutputBytes: 10_000,
    });
    const done = await manager.wait({
      processId: started.processId,
      yieldMs: 2_000,
    });
    expect(done.status).toBe("timed_out");
  });

  it("reports truncation when a cursor falls behind the bounded output ring", async () => {
    const manager = new ProcessManager();
    const started = await manager.start({
      file: process.execPath,
      args: [
        "-e",
        "for(let i=0;i<20;i++) process.stdout.write(String(i).padStart(4,'0')+'\\n')",
      ],
      cwd,
      background: false,
      timeoutMs: 5_000,
      yieldMs: 5_000,
      maxOutputBytes: 20,
    });
    expect(started.droppedBytes).toBeGreaterThan(0);
    expect(manager.snapshot(started.processId, 1).truncated).toBe(true);
  });
});
