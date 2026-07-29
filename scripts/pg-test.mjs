/**
 * Run the Postgres integration tests against a real database in Docker.
 *
 * Node rather than a shell script so it works the same on Windows and POSIX
 * (same reason as install-hooks.mjs). Brings the container up, waits for its
 * healthcheck, runs the integration spec, and always tears down — including on
 * Ctrl-C, so a cancelled run doesn't leave a container holding port 55432.
 *
 * Usage: npm run test:pg [-- --watch etc.]
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const COMPOSE = ['compose', '-f', 'docker-compose.test.yml'];
const URL = 'postgres://factfluency:factfluency@127.0.0.1:55432/fact_fluency_test';

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts });

function compose(args, opts) {
  return run('docker', [...COMPOSE, ...args], opts);
}

function down() {
  // -v also drops the (tmpfs) volume; quiet, since this runs on the error path.
  compose(['down', '-v'], { stdio: 'ignore' });
}

const daemon = run('docker', ['info'], { stdio: 'ignore' });
if (daemon.status !== 0) {
  console.error(
    'Docker does not appear to be running.\n' +
      'These tests need a real Postgres; start Docker Desktop and retry.\n' +
      '(`npm test` does not need Docker — it covers Postgres via pg-mem.)',
  );
  process.exit(1);
}

// A container left behind by a previous cancelled run would hold the port.
down();

let exitCode = 1;
try {
  process.on('SIGINT', () => {
    down();
    process.exit(130);
  });

  // --wait blocks on the healthcheck, so the first connection can't race startup.
  if (compose(['up', '-d', '--wait']).status !== 0) {
    throw new Error('could not start the test database');
  }

  // Invoke vitest's own JS entry with this Node binary rather than the `npx`
  // wrapper: Node refuses to spawn a .cmd shim without a shell on Windows, and
  // going through a shell would mean quoting passthrough args by hand.
  const vitestBin = fileURLToPath(import.meta.resolve('vitest/vitest.mjs'));
  const vitest = run(
    process.execPath,
    [vitestBin, 'run', 'src/db/postgres.integration.test.ts', ...process.argv.slice(2)],
    { cwd: 'server', env: { ...process.env, FF_TEST_PG_URL: URL } },
  );
  if (vitest.error) throw vitest.error;
  exitCode = vitest.status ?? 1;
} catch (err) {
  console.error(String(err instanceof Error ? err.message : err));
} finally {
  down();
}

process.exit(exitCode);
