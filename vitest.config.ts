import { defineConfig } from 'vitest/config';

/**
 * Two projects with different characteristics:
 *
 * - `unit` exercises pure logic — metric arithmetic, `/proc` parsing, alert
 *   evaluation, request validation — against fixtures held in the
 *   repository. Nothing is read from the running host, so the results are
 *   identical on any machine and the files may run in parallel.
 * - `integration` starts a real agent, a real SQLite database in a
 *   temporary directory and a real HTTP server on a loopback port, and
 *   reads the metrics of the machine running the suite. Each file makes
 *   its own temporary directory and asks the kernel for a free port, so
 *   the files are independent of each other and of any Sable Monitor the
 *   developer happens to be running.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
