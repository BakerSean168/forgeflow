import { buildControlPlane } from './app.js';
import { installGracefulShutdown } from './processLifecycle.js';

const runtime = await buildControlPlane();
installGracefulShutdown(() => runtime.app.close());
await runtime.app.listen({ host: runtime.host, port: runtime.port });
