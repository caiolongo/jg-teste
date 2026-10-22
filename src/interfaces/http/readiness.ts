import type { OnModuleDestroy } from '@nestjs/common';

export type CheckStatus = 'up' | 'down';

export interface ReadinessReport {
  ready: boolean;
  shuttingDown: boolean;
  checks: Record<string, CheckStatus>;
}

export type DependencyCheck = () => Promise<void>;

const withTimeout = (check: DependencyCheck, ms: number) =>
  Promise.race([check(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

/**
 * Readiness = "send me traffic": every dependency answers within the timeout and the app is not shutting down.
 * On SIGTERM `onModuleDestroy` runs first, so the instance reports not-ready while it drains.
 */
export class Readiness implements OnModuleDestroy {
  private shuttingDown = false;

  constructor(
    private readonly checks: Record<string, DependencyCheck>,
    private readonly timeoutMs = 2_000,
  ) {}

  onModuleDestroy(): void {
    this.shuttingDown = true;
  }

  async check(): Promise<ReadinessReport> {
    const entries = await Promise.all(
      Object.entries(this.checks).map(async ([name, check]): Promise<[string, CheckStatus]> => {
        try {
          await withTimeout(check, this.timeoutMs);
          return [name, 'up'];
        } catch {
          return [name, 'down'];
        }
      }),
    );
    const checks = Object.fromEntries(entries);
    return {
      ready: !this.shuttingDown && entries.every(([, status]) => status === 'up'),
      shuttingDown: this.shuttingDown,
      checks,
    };
  }
}
