interface PendingApproval {
  readonly runId: string;
  readonly resolve: (allowed: boolean) => void;
}

export class ApprovalGate {
  readonly #pending = new Map<string, PendingApproval>();

  public wait(
    runId: string,
    toolCallId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (this.#pending.has(toolCallId))
      throw new Error(`approval is already pending: ${toolCallId}`);
    return new Promise<boolean>((resolve, reject) => {
      const onAbort = (): void => {
        this.#pending.delete(toolCallId);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("run cancelled"),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(toolCallId, {
        runId,
        resolve: (allowed) => {
          signal.removeEventListener("abort", onAbort);
          resolve(allowed);
        },
      });
    });
  }

  public resolve(runId: string, toolCallId: string, allowed: boolean): void {
    const pending = this.#pending.get(toolCallId);
    if (pending === undefined || pending.runId !== runId)
      throw new Error(`unknown pending approval: ${toolCallId}`);
    this.#pending.delete(toolCallId);
    pending.resolve(allowed);
  }

  public list(runId: string): readonly string[] {
    return [...this.#pending.entries()]
      .filter(([, pending]) => pending.runId === runId)
      .map(([id]) => id)
      .sort();
  }
}
