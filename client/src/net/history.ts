import type { ServiceRef } from "../store/types";
import { logToBackend } from "./log";
import { getHistoryPage, type HistoryPage } from "./rest";
import * as terminals from "./terminals";

const MAX_PAGE_CHUNKS = 8;
const MAX_PAGE_BYTES = 64 * 1024;
const BACKGROUND_MIN_GAP_MS = 250;
const LIVE_QUIET_MS = 250;

interface Job {
  taskId: string;
  throughSeq: number;
  nextAfter: number;
  session: terminals.HistorySession;
}

interface Active {
  job: Job;
  generation: number;
  background: boolean;
  controller: AbortController;
}

export class ServiceHistoryRecovery {
  private generation = 0;
  private expectedReplay = new Set<string>();
  private jobs = new Map<string, Job>();
  private incomplete = new Set<string>();
  private active: Active | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private selectedTaskId?: string;
  private lastLiveAt = 0;
  private backgroundReadyAt = 0;

  constructor(
    private readonly serviceId: string,
    private readonly service: ServiceRef,
    selectedKey?: string,
  ) {
    this.selectedTaskId = this.taskFromSelection(selectedKey);
  }

  start(taskIds: string[]): void {
    this.generation++;
    this.expectedReplay = new Set(taskIds);
    this.jobs.clear();
    this.clearTimer();
    this.backgroundReadyAt = 0;
    this.active?.controller.abort();
    terminals.cancelHistoryForService(this.serviceId);
  }

  add(taskId: string, throughSeq: number): void {
    this.incomplete.add(taskId);
    const session = terminals.beginHistory(this.serviceId, taskId, throughSeq);
    if (!session) return;
    this.jobs.set(taskId, {
      taskId,
      throughSeq,
      nextAfter: 0,
      session,
    });
    this.pump();
  }

  replayDone(taskId: string): void {
    this.expectedReplay.delete(taskId);
    this.pump();
  }

  selectionChanged(selectedKey?: string): void {
    this.selectedTaskId = this.taskFromSelection(selectedKey);
    this.clearTimer();
    this.pump();
  }

  liveActivity(): void {
    this.lastLiveAt = Date.now();
  }

  blocksCursor(taskId: string): boolean {
    return this.incomplete.has(taskId);
  }

  committed(taskId: string): void {
    this.incomplete.delete(taskId);
  }

  remove(taskId: string): void {
    this.incomplete.delete(taskId);
    this.jobs.delete(taskId);
    if (this.active?.job.taskId === taskId) this.active.controller.abort();
  }

  cancel(): void {
    this.generation++;
    this.expectedReplay.clear();
    this.jobs.clear();
    this.clearTimer();
    this.active?.controller.abort();
    terminals.cancelHistoryForService(this.serviceId);
  }

  private taskFromSelection(selectedKey?: string): string | undefined {
    const prefix = `${this.serviceId}::`;
    return selectedKey?.startsWith(prefix)
      ? selectedKey.slice(prefix.length)
      : undefined;
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private nextJob(): Job | undefined {
    if (this.selectedTaskId) {
      const selected = this.jobs.get(this.selectedTaskId);
      if (selected) return selected;
    }
    if (this.expectedReplay.size > 0) return undefined;
    return this.jobs.values().next().value;
  }

  private pump(ignoreBackgroundDelay = false): void {
    if (this.active || this.timer !== null) return;
    const job = this.nextJob();
    if (!job) return;
    const background = job.taskId !== this.selectedTaskId;
    if (background && !ignoreBackgroundDelay) {
      const readyAt = Math.max(
        this.backgroundReadyAt,
        this.lastLiveAt + LIVE_QUIET_MS,
      );
      const delay = Math.max(0, readyAt - Date.now());
      if (delay > 0) {
        this.timer = setTimeout(() => {
          this.timer = null;
          this.pump(true);
        }, delay);
        return;
      }
    }
    const active = {
      job,
      generation: this.generation,
      background,
      controller: new AbortController(),
    };
    this.active = active;
    void this.runPage(active);
  }

  private isCurrent(active: Active): boolean {
    return (
      this.active === active &&
      this.generation === active.generation &&
      this.jobs.get(active.job.taskId) === active.job
    );
  }

  private validatePage(job: Job, page: HistoryPage): void {
    if (
      page.chunks.length === 0 ||
      page.chunks.length > MAX_PAGE_CHUNKS ||
      page.chunks.reduce((bytes, chunk) => bytes + chunk.data.byteLength, 0) >
        MAX_PAGE_BYTES
    ) {
      throw new Error("Invalid history page size.");
    }
    let seq = job.nextAfter;
    for (const chunk of page.chunks) {
      seq++;
      if (chunk.seq !== seq || seq > job.throughSeq) {
        throw new Error(
          `Unexpected history sequence ${chunk.seq}; wanted ${seq}.`,
        );
      }
    }
    if (
      page.nextAfter !== seq ||
      page.nextAfter <= job.nextAfter ||
      page.nextAfter > job.throughSeq
    ) {
      throw new Error(`Invalid history cursor ${page.nextAfter}.`);
    }
  }

  private async runPage(active: Active): Promise<void> {
    const { job } = active;
    const started = Date.now();
    try {
      const page = await getHistoryPage(
        this.service,
        job.taskId,
        job.nextAfter,
        job.throughSeq,
        active.controller.signal,
      );
      if (!this.isCurrent(active)) return;
      this.validatePage(job, page);
      for (const chunk of page.chunks) {
        await terminals.writeHistory(job.session, chunk.seq, chunk.data);
        if (!this.isCurrent(active)) return;
      }
      job.nextAfter = page.nextAfter;
      if (job.nextAfter === job.throughSeq) {
        await terminals.finishHistory(job.session);
        if (!this.isCurrent(active)) return;
        this.jobs.delete(job.taskId);
      }
    } catch (error) {
      if (this.jobs.get(job.taskId) === job) {
        this.jobs.delete(job.taskId);
        terminals.cancelHistorySession(job.session);
        logToBackend(
          "warn",
          `history recovery failed for ${job.taskId} after ${job.nextAfter}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    } finally {
      if (this.active === active) {
        this.active = null;
        if (active.background) {
          const elapsed = Date.now() - started;
          this.backgroundReadyAt =
            Date.now() + Math.max(BACKGROUND_MIN_GAP_MS, elapsed);
        }
        this.pump();
      }
    }
  }
}
