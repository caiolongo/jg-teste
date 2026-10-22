import { setDefaultTimeout } from 'bun:test';

// Integration tests wait on real SQS redelivery and lock timeouts.
setDefaultTimeout(60_000);
