/**
 * Async queue that processes items sequentially as they arrive.
 * Starts processing immediately when an item is enqueued.
 */
export class AsyncQueue<T> {
  private queue: T[] = [];
  private processing = false;

  constructor(private processor: (item: T) => Promise<void>) {}

  enqueue(item: T): void {
    this.queue.push(item);
    void this.processNext();
  }

  private async processNext(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      await this.processor(item);
    }
    this.processing = false;
  }
}
