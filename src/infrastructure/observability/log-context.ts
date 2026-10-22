import { AsyncLocalStorage } from 'node:async_hooks';

export interface LogContextFields {
  correlationId?: string | undefined;
  messageId?: string | undefined;
}

const storage = new AsyncLocalStorage<LogContextFields>();

/**
 * Ambient context for one request or message. Everything awaited inside `run` — use cases, repositories,
 * loggers — sees the same correlationId without passing it around; the logger stamps it on every line.
 */
export const LogContext = {
  run<T>(fields: LogContextFields, fn: () => T): T {
    return storage.run({ ...storage.getStore(), ...fields }, fn);
  },
  current(): LogContextFields {
    return storage.getStore() ?? {};
  },
};
