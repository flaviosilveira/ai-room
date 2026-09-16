#!/usr/bin/env node
import { assertSupportedRuntime } from "../dist/preflight.js";

assertSupportedRuntime();
await import("../dist/cli.js");
