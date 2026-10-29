// zod 4 probes `new Function` to JIT-compile parsers; the CSP forbids eval, so turn the probe off.
import { config } from 'zod';

config({ jitless: true });
