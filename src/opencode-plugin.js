// claudespeak for opencode: when a top-level session finishes a turn, its last assistant message goes to
// claudespeak's hook, which speaks a summary. A template: `claudespeak install` copies it to opencode's
// plugins folder with NODE and HOOK filled in (--claudespeak marks it as ours); `uninstall` removes it.
// It runs inside opencode (Bun), not Node. opencode 2.x calls setup() (an event stream); 1.x calls server().
import { spawn } from "node:child_process";

const NODE = "{{NODE}}", HOOK = "{{HOOK}}";
const data = (r) => r?.data ?? r;   // 1.x's SDK wraps results in { data }
const texts = (parts) => (parts || []).filter((p) => p?.type === "text" && !p.synthetic && !p.ignored).map((p) => p.text).join("\n\n").trim();
/** Subagent sessions and claudespeak's own summary sessions stay quiet. */
const quiet = (s) => !s || s.parentID || /^claudespeak/.test(s.title || "") || process.env.CLAUDESPEAK_CHILD;

/** The last assistant message with text, from 2.x's session context or 1.x's message list. */
function lastText(messages) {
  const m = [...(messages || [])].reverse().find((x) => (x.type ?? x.info?.role) === "assistant" && texts(x.content ?? x.parts));
  return m ? texts(m.content ?? m.parts) : "";
}

function speak(text, cwd) {
  if (!text) return;
  const p = spawn(NODE, [HOOK, "--agent", "opencode", "--claudespeak"], { detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  p.on("error", () => {});
  p.stdin.on("error", () => {});
  p.stdin.end(JSON.stringify({ cwd, last_assistant_message: text }));
  p.unref();
}

export default {
  id: "claudespeak",
  lastText,   // for the smoke test
  async setup(ctx) {
    (async () => {
      for await (const e of ctx.event.subscribe()) {
        if (e.type !== "session.execution.succeeded") continue;
        try {
          const sessionID = e.data.sessionID, s = await ctx.session.get({ sessionID });
          if (quiet(s)) continue;
          speak(lastText(await ctx.session.context({ sessionID })), s.location?.directory || ctx.location?.directory);
        } catch {}
      }
    })().catch(() => {});
  },
  async server({ client, directory }) {
    return {
      event: async ({ event }) => {
        if (event.type !== "session.idle") return;
        try {
          const id = event.properties.sessionID, s = data(await client.session.get({ path: { id } }));
          if (quiet(s)) return;
          speak(lastText(data(await client.session.messages({ path: { id } }))), s.directory || directory);
        } catch {}
      },
    };
  },
};
