export interface GracefulShutdownProcess {
  once(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  off(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  exitCode?: string | number | null;
}

export interface GracefulShutdownHandle {
  shutdown(signal: 'SIGTERM' | 'SIGINT'): Promise<void>;
  uninstall(): void;
}

export function installGracefulShutdown(
  close: () => Promise<void>,
  processLike: GracefulShutdownProcess = process,
  onError: (error: unknown, signal: 'SIGTERM' | 'SIGINT') => void = (error, signal) => {
    console.error('ForgeFlow graceful shutdown failed after ' + signal, error);
  },
): GracefulShutdownHandle {
  let closing: Promise<void> | undefined;
  const shutdown = (signal: 'SIGTERM' | 'SIGINT'): Promise<void> => {
    if (!closing) {
      closing = Promise.resolve()
        .then(close)
        .catch((error) => {
          processLike.exitCode = 1;
          onError(error, signal);
        });
    }
    return closing;
  };
  const onSigterm = () => void shutdown('SIGTERM');
  const onSigint = () => void shutdown('SIGINT');
  processLike.once('SIGTERM', onSigterm);
  processLike.once('SIGINT', onSigint);
  return {
    shutdown,
    uninstall: () => {
      processLike.off('SIGTERM', onSigterm);
      processLike.off('SIGINT', onSigint);
    },
  };
}
