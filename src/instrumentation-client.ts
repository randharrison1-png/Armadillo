import { config } from 'zod/v4/core';

/**
 * Runs in the browser before the app hydrates. Zod 4 probes `new Function('')` to decide whether it
 * may JIT-compile its parsers; under our Content-Security-Policy (no 'unsafe-eval') that probe is
 * itself reported as a violation even though zod catches it. Telling zod up front to skip the JIT
 * keeps the browser console and CSP reports clean; client-side parsing is tiny, so nothing is lost.
 */
config({ jitless: true });
