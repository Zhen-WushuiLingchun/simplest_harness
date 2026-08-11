import { describe, expect, it } from "vitest";
import { formatAnsiFrame } from "../../src/tui/app.js";

describe("TMSH TUI fallback frame", () => {
  it("keeps the YOLO marker, model, status, transcript, and workspace visible", () => {
    const frame = formatAnsiFrame({
      mode: "yolo",
      modelId: "deepseek.main",
      workspace: "F:/project",
      status: "running",
      transcript: "old line\nTUI observed response\n[done]",
      maxTranscriptLines: 2,
      color: false,
    });
    expect(frame).toContain("TMSH YOLO");
    expect(frame).toContain("model=deepseek.main");
    expect(frame).toContain("TUI observed response");
    expect(frame).toContain("[done]");
    expect(frame).toContain("workspace=F:/project");
    expect(frame).not.toContain("old line");
  });
});
