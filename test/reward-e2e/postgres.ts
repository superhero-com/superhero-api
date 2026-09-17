/**
 * Boot a throwaway PostgreSQL for tests that must run against the real engine.
 *
 * The reward dashboards are mostly SQL and TypeORM metadata, and the unit specs
 * mock the query builder — so they cannot catch a bad column name, a broken
 * `IN (:...x)` expansion, or a constraint that only exists in Postgres. This
 * gives those tests a real server without requiring one to be installed in CI:
 * `start()` returns null when no binary is present, and the caller skips.
 */
import { execFileSync, spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export type PostgresHandle = {
  url: string;
  stop: () => void;
};

function findBinDir(): string | null {
  const candidates = [
    ...(fs.existsSync('/usr/lib/postgresql')
      ? fs
          .readdirSync('/usr/lib/postgresql')
          .sort()
          .reverse()
          .map((v) => `/usr/lib/postgresql/${v}/bin`)
      : []),
    '/usr/local/bin',
    '/usr/bin',
    '/opt/homebrew/bin',
  ];
  return (
    candidates.find(
      (dir) =>
        fs.existsSync(path.join(dir, 'initdb')) &&
        fs.existsSync(path.join(dir, 'postgres')),
    ) || null
  );
}

/**
 * PostgreSQL refuses to run as root, and CI containers frequently are root.
 * Returns the uid/gid to run the server under, or null when we are already
 * unprivileged and can run as ourselves.
 */
function postgresUser(): { uid: number; gid: number } | null {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    return null;
  }
  try {
    const uid = Number(
      execFileSync('id', ['-u', 'postgres'], { encoding: 'utf8' }).trim(),
    );
    const gid = Number(
      execFileSync('id', ['-g', 'postgres'], { encoding: 'utf8' }).trim(),
    );
    return Number.isInteger(uid) && Number.isInteger(gid) ? { uid, gid } : null;
  } catch {
    return null;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitForReady(
  binDir: string,
  port: number,
  timeoutMs = 30000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      execFileSync(path.join(binDir, 'pg_isready'), [
        '-h',
        '127.0.0.1',
        '-p',
        String(port),
      ]);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

/**
 * Returns null when Postgres is not available here, so a suite can skip rather
 * than fail. A skipped suite is honest; a suite that silently tests nothing
 * because it swallowed the error is not.
 */
export async function startPostgres(): Promise<PostgresHandle | null> {
  const binDir = findBinDir();
  if (!binDir) return null;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reward-e2e-pg-'));
  const port = await freePort();
  const asUser = postgresUser();
  // Running as root means the server must drop to the postgres account, and it
  // can only do that if it owns its own data directory.
  if (asUser) {
    try {
      fs.chownSync(dataDir, asUser.uid, asUser.gid);
    } catch {
      fs.rmSync(dataDir, { recursive: true, force: true });
      return null;
    }
  }
  const runAs = asUser ? { uid: asUser.uid, gid: asUser.gid } : {};
  let child: ChildProcess | null = null;

  const cleanup = () => {
    try {
      child?.kill('SIGQUIT');
    } catch {
      /* already gone */
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  };

  try {
    // Trust auth: the server listens on loopback, on a random port, and is
    // destroyed with its data directory when the suite ends.
    execFileSync(
      path.join(binDir, 'initdb'),
      ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '--encoding=UTF8'],
      { stdio: 'ignore', ...runAs },
    );

    child = spawn(
      path.join(binDir, 'postgres'),
      ['-D', dataDir, '-p', String(port), '-h', '127.0.0.1', '-k', dataDir],
      { stdio: 'ignore', ...runAs },
    );
    child.unref();

    if (!(await waitForReady(binDir, port))) {
      cleanup();
      return null;
    }

    return {
      url: `postgres://postgres@127.0.0.1:${port}/postgres`,
      stop: cleanup,
    };
  } catch {
    cleanup();
    return null;
  }
}
