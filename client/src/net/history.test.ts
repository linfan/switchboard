import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getHistoryPage, type HistoryPage } from "./rest";
import { ServiceHistoryRecovery } from "./history";
import * as terminals from "./terminals";

vi.mock("./rest", () => ({ getHistoryPage: vi.fn() }));
vi.mock("./terminals", () => ({
  beginHistory: vi.fn(),
  writeHistory: vi.fn(),
  finishHistory: vi.fn(),
  cancelHistoryForService: vi.fn(),
  cancelHistorySession: vi.fn(),
}));
vi.mock("./log", () => ({ logToBackend: vi.fn() }));

const service = { url: "http://host", token: "token" };
const getPage = vi.mocked(getHistoryPage);
const beginHistory = vi.mocked(terminals.beginHistory);
const writeHistory = vi.mocked(terminals.writeHistory);
const finishHistory = vi.mocked(terminals.finishHistory);
const cancelSession = vi.mocked(terminals.cancelHistorySession);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function page(seq: number, nextAfter = seq): HistoryPage {
  return {
    chunks: [{ seq, data: new Uint8Array([0, 0xff]) }],
    nextAfter,
  };
}

async function flush(ms = 0): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  if (ms > 0) await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.resetAllMocks();
  beginHistory.mockImplementation((serviceId, taskId, throughSeq) => ({
    id: 1,
    serviceId,
    taskId,
    throughSeq,
  }));
  writeHistory.mockResolvedValue(undefined);
  finishHistory.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ServiceHistoryRecovery", () => {
  it("starts the selected task before earlier background metadata and initial replay completion", async () => {
    const selected = deferred<HistoryPage>();
    const background = deferred<HistoryPage>();
    getPage
      .mockReturnValueOnce(selected.promise)
      .mockReturnValueOnce(background.promise);
    const recovery = new ServiceHistoryRecovery(
      "svc",
      service,
      "svc::selected",
    );
    recovery.start(["background", "selected"]);
    recovery.add("background", 1);
    expect(getPage).not.toHaveBeenCalled();

    recovery.add("selected", 1);
    expect(getPage).toHaveBeenCalledWith(
      service,
      "selected",
      0,
      1,
      expect.any(AbortSignal),
    );
    selected.resolve(page(1));
    await flush();
    expect(finishHistory).toHaveBeenCalledOnce();
    expect(getPage).toHaveBeenCalledOnce();

    recovery.replayDone("selected");
    recovery.replayDone("background");
    await flush();
    expect(getPage).toHaveBeenCalledWith(
      service,
      "background",
      0,
      1,
      expect.any(AbortSignal),
    );
    background.resolve(page(1));
    await flush();
    recovery.cancel();
  });

  it("promotes a new selection at the page boundary and resumes the preempted job", async () => {
    vi.useFakeTimers();
    const first = deferred<HistoryPage>();
    const selected = deferred<HistoryPage>();
    const resumed = deferred<HistoryPage>();
    getPage
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(selected.promise)
      .mockReturnValueOnce(resumed.promise);
    const recovery = new ServiceHistoryRecovery("svc", service);
    recovery.start([]);
    recovery.add("background", 2);
    recovery.add("selected", 1);
    expect(getPage).toHaveBeenCalledWith(
      service,
      "background",
      0,
      2,
      expect.any(AbortSignal),
    );

    recovery.selectionChanged("svc::selected");
    expect(getPage).toHaveBeenCalledOnce();
    first.resolve(page(1));
    await flush();
    expect(getPage).toHaveBeenCalledWith(
      service,
      "selected",
      0,
      1,
      expect.any(AbortSignal),
    );

    selected.resolve(page(1));
    await flush();
    expect(getPage).toHaveBeenCalledTimes(2);
    await flush(249);
    expect(getPage).toHaveBeenCalledTimes(2);
    await flush(1);
    expect(getPage).toHaveBeenCalledWith(
      service,
      "background",
      1,
      2,
      expect.any(AbortSignal),
    );
    resumed.resolve(page(2));
    await flush();
    recovery.cancel();
  });

  it("does not starve background pages during continuous live activity", async () => {
    vi.useFakeTimers();
    const first = deferred<HistoryPage>();
    getPage
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(deferred<HistoryPage>().promise);
    const recovery = new ServiceHistoryRecovery("svc", service);
    recovery.start([]);
    recovery.add("background", 2);
    first.resolve(page(1));
    await flush();

    await flush(100);
    recovery.liveActivity();
    await flush(100);
    recovery.liveActivity();
    await flush(49);
    expect(getPage).toHaveBeenCalledOnce();
    await flush(1);
    expect(getPage).toHaveBeenCalledWith(
      service,
      "background",
      1,
      2,
      expect.any(AbortSignal),
    );
    recovery.cancel();
  });

  it("matches the background gap to the previous page duration", async () => {
    vi.useFakeTimers();
    const first = deferred<HistoryPage>();
    getPage
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(deferred<HistoryPage>().promise);
    const recovery = new ServiceHistoryRecovery("svc", service);
    recovery.start([]);
    recovery.add("background", 2);

    await flush(1000);
    first.resolve(page(1));
    await flush();
    await flush(999);
    expect(getPage).toHaveBeenCalledOnce();
    await flush(1);
    expect(getPage).toHaveBeenCalledWith(
      service,
      "background",
      1,
      2,
      expect.any(AbortSignal),
    );
    recovery.cancel();
  });

  it("drops a response from an older connection generation", async () => {
    vi.useFakeTimers();
    const oldPage = deferred<HistoryPage>();
    const newPage = deferred<HistoryPage>();
    getPage
      .mockReturnValueOnce(oldPage.promise)
      .mockReturnValueOnce(newPage.promise);
    const recovery = new ServiceHistoryRecovery("svc", service);
    recovery.start([]);
    recovery.add("task", 1);
    recovery.start([]);
    recovery.add("task", 1);

    oldPage.resolve(page(1));
    await flush();
    expect(writeHistory).not.toHaveBeenCalled();
    await flush(250);
    expect(getPage).toHaveBeenCalledTimes(2);
    newPage.resolve(page(1));
    await flush();
    expect(writeHistory).toHaveBeenCalledOnce();
    recovery.cancel();
  });

  it("aborts the old request without overlapping a new generation", async () => {
    const signals: AbortSignal[] = [];
    getPage.mockImplementation((_service, _task, _after, _through, signal) => {
      signals.push(signal!);
      return new Promise<HistoryPage>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    });
    const recovery = new ServiceHistoryRecovery("svc", service, "svc::task");
    recovery.start([]);
    recovery.add("task", 1);
    recovery.start([]);
    recovery.add("task", 1);
    await flush();

    expect(signals[0].aborted).toBe(true);
    expect(getPage).toHaveBeenCalledTimes(2);
    recovery.cancel();
  });

  it("keeps the cursor blocked after failure and releases it only on commit", async () => {
    getPage.mockRejectedValueOnce(new Error("failed"));
    const recovery = new ServiceHistoryRecovery("svc", service, "svc::task");
    recovery.start([]);
    recovery.add("task", 1);
    expect(recovery.blocksCursor("task")).toBe(true);
    await flush();
    expect(recovery.blocksCursor("task")).toBe(true);

    recovery.start([]);
    expect(recovery.blocksCursor("task")).toBe(true);
    recovery.committed("task");
    expect(recovery.blocksCursor("task")).toBe(false);
    recovery.cancel();
  });

  it("rejects a non-contiguous page before writing it", async () => {
    getPage.mockResolvedValueOnce(page(2));
    const recovery = new ServiceHistoryRecovery("svc", service);
    recovery.start([]);
    recovery.add("task", 2);
    await flush();

    expect(writeHistory).not.toHaveBeenCalled();
    expect(cancelSession).toHaveBeenCalledOnce();
    recovery.cancel();
  });

  it("contains page failures to the offscreen restore and continues other jobs", async () => {
    const background = deferred<HistoryPage>();
    getPage
      .mockRejectedValueOnce(new Error("network failed"))
      .mockReturnValueOnce(background.promise);
    const recovery = new ServiceHistoryRecovery(
      "svc",
      service,
      "svc::selected",
    );
    recovery.start([]);
    recovery.add("selected", 1);
    recovery.add("background", 1);
    await flush();

    expect(cancelSession).toHaveBeenCalledOnce();
    expect(getPage).toHaveBeenCalledWith(
      service,
      "background",
      0,
      1,
      expect.any(AbortSignal),
    );
    background.resolve(page(1));
    await flush();
    recovery.cancel();
  });
});
