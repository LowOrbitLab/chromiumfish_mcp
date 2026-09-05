import { AsyncLocalStorage } from "node:async_hooks";

const requestSignal = new AsyncLocalStorage<AbortSignal>();

export function withOperationSignal<T>(signal: AbortSignal, operation: () => T): T {
  return requestSignal.run(signal, operation);
}

/** Serializes one session; nested navigation and snapshot calls may re-enter. */
class OperationQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly current = new AsyncLocalStorage<{ active: boolean }>();

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.current.getStore()?.active) return operation();
    const signal = requestSignal.getStore();
    const result = this.tail.then(() => {
      // A call cancelled while queued must not run silently once the previous action ends.
      if (signal?.aborted) throw new Error("Tool call cancelled before execution");
      const scope = { active: true };
      return this.current.run(scope, async () => {
        try {
          return await operation();
        } finally {
          scope.active = false;
        }
      });
    });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

const queues = new WeakMap<object, OperationQueue>();

/** Guards every public page operation in one place, so no method maintains its own lock and release path. */
export function serialized<This extends object, Args extends unknown[], Result>(
  method: (this: This, ...args: Args) => Promise<Result>,
  _context: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => Promise<Result>>,
): (this: This, ...args: Args) => Promise<Result> {
  return function (...args: Args): Promise<Result> {
    let queue = queues.get(this);
    if (!queue) {
      queue = new OperationQueue();
      queues.set(this, queue);
    }
    return queue.run(() => method.apply(this, args));
  };
}
