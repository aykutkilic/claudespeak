#!/usr/bin/env node
import { pluginMain } from "../src/bootstrap.mjs";

try { await pluginMain(process.argv.slice(2)); }
catch (e) { console.error("claudespeak: " + e.message); process.exitCode = 1; }
