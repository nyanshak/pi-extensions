// Test entry point - runs all test files

import "./auth.test.ts";
import "./server.test.ts";
import "./websocket.test.ts";
import "./acp.test.ts";

import { run } from "./test.js";
run();