/**
 * Global process-level guards shared by the main (`main.ts`) and worker
 * (`worker.bootstrap.ts`) bootstraps.
 *
 * After logging we explicitly exit with code 1 so that the process manager
 * (Docker, PM2, systemd, etc.) can restart the service. Continuing after these
 * events is unsafe. Extracted (rather than duplicated) so both entrypoints share
 * identical behavior and cannot diverge.
 */
export function registerProcessGuards(): void {
  process.on('uncaughtException', (error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('UNCAUGHT EXCEPTION, process will exit:', error);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    // eslint-disable-next-line no-console
    console.error('UNHANDLED REJECTION, process will exit:', reason);
    process.exit(1);
  });

  process.on('exit', (code: number) => {
    // eslint-disable-next-line no-console
    console.error('Process exiting with code', code);
  });
}
