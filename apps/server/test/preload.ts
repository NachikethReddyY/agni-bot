import { Router } from "../src/models/router.ts";

// Retries still run in tests, just without the 2s wait between them.
Router.retryBackoffMs = 0;
