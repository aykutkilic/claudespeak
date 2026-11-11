---
name: setup
description: Install or update the shared claudespeak voice runtime and local model for this plugin.
---

Resolve `../../scripts/plugin.mjs` relative to this SKILL.md's directory to get the plugin entry point. Use its absolute path (quoted) in every command below. The plugin shares a durable runtime in `~/.claudespeak`; the working directory remains the user's project.

Run `node "<absolute plugin entry point>" setup`. This installs Node dependencies into a user-owned runtime directory and downloads the approximately 410 MB Supertonic model once. It does not edit the agent's hook configuration: the plugin supplies its hooks. Run the same command again to update the shared runtime from this plugin version.

After setup succeeds, run `node "<absolute plugin entry point>" test` so the user can hear a short sample, and report the result.
