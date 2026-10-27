# Age of Agents

An Age of Empires style control panel for a fleet of AI agents. Each agent is a unit on a map of your
codebase. It walks to the folder it is working in, raises a `?` when it needs your approval and a `!` when
it fails or gets blocked. An alert feed pings you, and the command card (Pause, Resume, Redirect, Stop,
Approve, Deny) acts on the real agent.

**Open it: [kdi208.github.io/Age-of-Agents](https://kdi208.github.io/Age-of-Agents/)**. It starts on a demo fleet.

There are three ways to use it.

| | What you see | Setup |
|---|---|---|
| **Demo** | 12 simulated agents. Everything is clickable, nothing is real. | None. Open the link above. |
| **Claude Code** | Every Claude Code session on your computer, live. | Two commands, below. |
| **Any agent** | Your own bots, scripts or other frameworks, live. | One HTTP request per update. |

## Try it with Claude Code (2 minutes)

You need Node 18 or newer. Nothing to download:

```sh
npx github:kdi208/Age-of-Agents setup   # once: adds hooks to ~/.claude/settings.json (a backup is kept)
npx github:kdi208/Age-of-Agents         # starts the bridge and opens the HUD at http://127.0.0.1:4545
```

The bridge also prints a link to the hosted HUD that is already connected to your computer. The first time
you open it, your browser may ask whether the page may reach apps on your device: allow it. If your browser
refuses (Safari can), use the `127.0.0.1` link instead.

Prefer plain files? Clone this repo and run `node fleet-bridge.js setup`, then `node fleet-bridge.js`.

Now start or continue any Claude Code session. It joins the fleet as a unit.

- To try it in one project only, run `npx github:kdi208/Age-of-Agents setup --here` inside that project. This
  writes `.claude/settings.local.json` instead.
- To undo it, run `npx github:kdi208/Age-of-Agents remove` (or `remove --here`).
- When the bridge isn't running, the hooks exit at once and change nothing.

Options: `--port 4545`, `--budget 50` (dollars, for the top bar), `--no-open`. Set the environment variable
`FLEET_APPROVAL_WAIT` to change how many seconds the HUD gets to answer a permission prompt (default 300).

### What each order does to a Claude Code session

| Order | Effect |
|---|---|
| **Approve / Deny** (A / X) | Answers the session's permission prompt. While the HUD is open, prompts wait for the HUD. If nobody answers within 5 minutes, or the HUD is closed, the normal terminal prompt appears instead. |
| **Pause** (P) | The session holds before its next tool call, for up to 55 minutes. |
| **Resume** (R) | Releases a paused session. |
| **Stop** (S) | Ends the session's current turn at its next tool call. You can keep typing in its terminal afterwards. |
| **Redirect** (D) | Queues an instruction. A working session gets it when it finishes its current turn and carries on with it. An idle session gets it with your next prompt. Claude treats it as a note from the HUD and may still use its judgment. |

Review Diff, Open PR and Spawn Helper only work in the demo for now.

Context left comes from the session's transcript. Cost is an estimate from token counts at list prices,
marked with `*`. Your real bill can differ.

## Connect any other agent

The bridge speaks a small JSON format. Each request carries the token the bridge prints at start (also in
`~/.fleet-bridge/token`).

```sh
TOKEN=$(cat ~/.fleet-bridge/token)
curl -X POST http://127.0.0.1:4545/api/agents \
  -H "X-Fleet-Token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"id": "etl-bot", "team": "data", "status": "working", "area": "pipelines", "task": "Load the orders", "log": "Read 12k rows"}'
```

Send the same request again with new fields whenever something changes. Only `id` is required. The rest
update what's shown.

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Required. Stable id of the agent. |
| `name` | string | Display name. Defaults to `id`. |
| `team` | string | Agents with the same team share a colour and a score row. |
| `role` | string | `builder`, `reviewer`, `tester`, `scout`, `fixer` or `scribe`. Sets the unit's tool. |
| `status` | string | `working`, `idle`, `approval`, `blocked`, `failing`, `paused` or `done`. Changing to `approval`, `blocked` or `failing` raises an alert. |
| `area` | string | The part of the codebase or system it is in. Each new area becomes a building on the map, and the unit walks there. |
| `task` | string | What it is doing, in a sentence. |
| `waitingOn` | string | With `approval`: what it wants to do ("push to main"). With `blocked`: what it waits for. |
| `log` | string or array | A string appends one line to its log. An array of `[time, text]` pairs replaces the log. |
| `ctx`, `ctxMax` | number | Tokens used in its context window, and the window size. Drives the green bar. |
| `cost` | number | Dollars spent so far. |
| `tasks` | number | Tasks finished. |
| `perm` | string | `Ask`, `Edits`, `Plan`, `Auto` or `Read-only`. |
| `runs` | string | Last few step results, such as `"ggr"` (g = ok, r = failed). |
| `alert` | string | One-off message for the alert feed. |

You can send one agent, an array of agents, or `{"agents": [...]}`.

### Getting orders back

When someone presses an order in the HUD, the bridge keeps it for that agent. Your agent fetches its orders:

```sh
curl "http://127.0.0.1:4545/api/commands?agent=etl-bot" -H "X-Fleet-Token: $TOKEN"
# {"commands":[{"agent":"etl-bot","order":"approve","text":"","at":1793063971480}]}
```

Orders are `pause`, `resume`, `redirect` (with `text`), `stop`, `approve` and `deny`. Each one is returned
once. To get them pushed instead, listen to `GET /api/stream?token=...`. It is a server-sent event stream
with `fleet`, `alert` and `command` events. `examples/my-agent.py` is a complete agent in 40 lines.

### All endpoints

| Method and path | What it does |
|---|---|
| `GET /` | The HUD, already connected to this bridge. |
| `GET /api/fleet` | The whole fleet as JSON. |
| `GET /api/stream?token=` | Live events: `fleet` (full snapshot), `alert`, `command`. |
| `POST /api/agents` | Add or update agents. |
| `DELETE /api/agents/:id` | Remove an agent. |
| `GET /api/commands?agent=` | Orders waiting for an agent. |
| `POST /api/command` | Send an order: `{"agent", "order", "text"}`. This is what the HUD calls. |
| `POST /hook` | Claude Code hook events. The hooks call it for you. |

## Safety

- The bridge listens on `127.0.0.1` only, so other machines can't reach it.
- Every call except the HUD page needs the token. Other web pages can't read the token, so they can't
  approve anything or read your sessions. Requests with an unexpected `Host` header are refused.
- The hooks fail open: if the bridge is off or crashes, Claude Code behaves exactly as it does without them.

## Files

- `index.html`: the HUD. A single page with no build step and no dependencies.
- `fleet-bridge.js`: the bridge and hook installer. A single file with no dependencies.
- `examples/my-agent.py`: a minimal agent that reports in and obeys orders.
