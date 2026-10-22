import type { Subprocess } from 'bun';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { TEST_DATABASE } from '../../support/database';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const SHOW_LOGS = process.env['CLUSTER_LOGS'] === '1';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export interface QueueSet {
  queueUrl: string;
  dlqUrl: string;
  eventsUrl: string;
}

/** Fast timings so crash/redelivery scenarios finish in seconds; everything else is the production config. */
export function clusterEnv(queues: QueueSet, extra: Record<string, string> = {}): Record<string, string> {
  return {
    DATABASE_NAME: TEST_DATABASE,
    DATABASE_POOL_MAX: '10',
    LOG_LEVEL: SHOW_LOGS ? 'info' : 'fatal',
    SQS_WAGER_QUEUE_URL: queues.queueUrl,
    SQS_WAGER_DLQ_URL: queues.dlqUrl,
    SQS_EVENTS_QUEUE_URL: queues.eventsUrl,
    SQS_WAIT_TIME_SECONDS: '1',
    SQS_RETRY_BASE_SECONDS: '1',
    SQS_RETRY_MAX_SECONDS: '4',
    OUTBOX_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_POLL_INTERVAL_MS: '100',
    PENDING_REFERENCE_BASE_DELAY_MS: '500',
    SHUTDOWN_TIMEOUT_MS: '5000',
    ...extra,
  };
}

/** One real application process: its own event loop, connection pool, consumer, relay and worker. */
export class Instance {
  private constructor(
    readonly name: string,
    readonly url: string,
    private readonly proc: Subprocess,
  ) {}

  /** `awaitReady: false` for processes expected to die on their own (fault injection) before serving traffic. */
  static async start(name: string, env: Record<string, string>, options: { awaitReady?: boolean } = {}): Promise<Instance> {
    const port = await freePort();
    const proc = Bun.spawn(['bun', 'run', 'src/main.ts'], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env, PORT: String(port) },
      stdout: SHOW_LOGS ? 'inherit' : 'ignore',
      stderr: SHOW_LOGS ? 'inherit' : 'ignore',
    });
    const instance = new Instance(name, `http://127.0.0.1:${port}`, proc);
    if (options.awaitReady ?? true) await instance.waitReady();
    return instance;
  }

  get pid(): number {
    return this.proc.pid;
  }

  /** Signal that terminated the process (e.g. 'SIGKILL'), once it has exited. */
  get signalCode(): Subprocess['signalCode'] {
    return this.proc.signalCode;
  }

  get exited(): Promise<number> {
    return this.proc.exited;
  }

  kill(signal: 'SIGKILL' | 'SIGTERM'): void {
    this.proc.kill(signal);
  }

  async stop(): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    this.proc.kill('SIGTERM');
    await this.proc.exited;
  }

  private async waitReady(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) {
        throw new Error(`${this.name} exited (${this.proc.exitCode ?? this.proc.signalCode}) before becoming ready`);
      }
      try {
        if ((await fetch(`${this.url}/health/ready`)).status === 200) return;
      } catch {
        // not listening yet
      }
      await Bun.sleep(100);
    }
    throw new Error(`${this.name} not ready within ${timeoutMs} ms`);
  }
}

export async function startCluster(size: number, env: Record<string, string>, prefix = 'instance'): Promise<Instance[]> {
  return Promise.all(Array.from({ length: size }, (_, i) => Instance.start(`${prefix}-${i + 1}`, env)));
}

export async function stopAll(instances: Instance[]): Promise<void> {
  await Promise.all(instances.map((i) => i.stop()));
}
