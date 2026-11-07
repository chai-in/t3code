# Pi

T3 Code can download an official, compatibility-pinned [Pi](https://pi.dev) runtime. You do not need
a standalone Pi, Node.js, or npm installation to use the managed runtime. Existing installations
continue using external Pi until you choose managed mode.

## Set Up Pi

1. Open T3 Code Settings, enable Pi, and select **managed** for **Runtime**.
2. Allow the first download to finish on the machine running the T3 Code server. T3 Code verifies
   the official release checksum and version before using it. Later launches work without downloading
   the runtime again.
3. Add your model provider's API-key environment variable to the Pi instance; mark it sensitive.
   Refresh Pi, then choose its model in a thread.

The managed runtime is pinned to Pi 1.5.0. It updates with T3 Code, not through `pi update` or the
provider updater. Managed downloads support Windows, macOS, and Linux on x64 and arm64. On Windows,
Pi's Bash tool still needs Git Bash; the runtime does not install a shell or sandbox tools.

Each managed Pi instance has its own configuration, authentication, extensions, trust decisions,
and native sessions under `<T3 home>/provider-homes/pi/instance-<hex-encoded instance ID>` (the default
`pi` instance uses `instance-7069`). It does not read or modify
`~/.pi/agent`, change your shell's `PATH`, or import credentials automatically. To configure a custom
endpoint, put Pi's `models.json` in that instance's directory. To use Pi's interactive `/login`, run
the managed executable on the server with `PI_CODING_AGENT_DIR` set to the instance directory.
Runtime files are under `<T3 home>/providers/pi/1.5.0/<platform>-<architecture>`; use `pi.exe` on
Windows and `pi` elsewhere. Stop Pi threads before changing its authentication or configuration.

For a remote or headless server, run the executable on that server over SSH. Open its authorization
URL on your own computer. If the callback cannot reach the server, paste the final redirect URL or
authorization code back into Pi when prompted. Do not copy live OAuth stores between machines.

### Use an existing installation

Select **external** for Runtime and set the binary path if `pi` is not on the server's `PATH`.
External mode supports Pi 0.80.5 or newer and uses your usual `~/.pi/agent` configuration, unless
provider environment variables override it. For example, set `PI_CODING_AGENT_DIR` to use a custom
agent directory. Update external Pi through the installer or package manager that owns it.

Switching runtimes does not copy native sessions or credentials. Keep the external installation and
agent directory until you have verified a new managed thread. To resume an external native session,
switch that instance back to external mode. Portable conversation handoff is available when changing
provider instances.

Provider launch arguments remain available in either mode. `--provider` must be paired with `--model`.
T3 Code rejects arguments that change Pi's execution mode or select a session because T3 owns those
parts of the process lifecycle. Managed mode also reserves `--session-dir` to keep sessions within
the instance's agent directory; external mode supports custom session directories.

## What Carries Over

T3 Code discovers the models reported by Pi and exposes their supported thinking levels. The
thinking picker marks the discovered active model's configured level as its default without
overriding it. Other models keep their Pi defaults when no level is selected. Threads
use Pi's native session files for resume, rollback, and forks within the same Pi instance. Forks
preserve the native conversation through the selected turn in the destination workspace.
Switching providers uses portable conversation context. Extension
dialogs appear in the T3 Code composer, and the composer context meter follows Pi's own usage
reporting while a response streams and after it settles.

Pi skills appear in the composer's `$` menu. This includes user skills and project skills that Pi
loads for the current workspace; selecting one uses Pi's native skill expansion.

Pi loads its normal user extensions, and project extensions once the folder is trusted in Pi.
Blocking `select`, `confirm`, `input`, and `editor` dialogs work in T3 Code. Notifications appear in
the work log. Extensions can publish status text near the composer. Terminal titles and generic
widgets do not have a T3 Code equivalent.

## Permission Modes

T3 Code applies the composer permission mode through Pi's blocking tool hook:

- **Supervised** asks before commands, file changes, and extension tools. Read-only tools continue.
- **Auto-accept edits** allows Pi's edit and write tools, but asks before commands and extension
  tools.
- **Full access** allows tools without T3 Code approval prompts.

The **Auto** option is not shown for Pi because Pi does not expose an AI approval reviewer.
Threads that already stored Auto before Pi support was added behave and display as Supervised.

Changing the mode restarts the Pi provider session and resumes the same native conversation. The
policy covers Pi tool calls; it is not an operating-system sandbox, and code that a trusted Pi
extension runs outside a tool call remains governed by Pi's own extension trust model.

T3 Code's `delegate_task` tool creates durable child threads in the shared subagent UI. If the user
installs Pi's example `subagent` extension, T3 Code also shows its task progress and results in that
UI. Pi runs those children without a session, so they cannot be opened or resumed as T3 Code
threads.

## Troubleshooting

- If Pi is unavailable, confirm that the configured binary runs on the server machine, then refresh
  the provider in Settings.
- If no models appear, confirm authentication and model configuration in the selected runtime's
  agent directory. Standalone Pi's credentials are separate from managed Pi's credentials.
- If discovery cannot complete, T3 Code keeps Pi available with the `Pi default` model. Start a
  thread to let the interactive Pi session handle any startup prompt.
- If Pi skips project settings, extensions, skills, prompts, MCP servers, or system prompt files
  because the folder is not trusted, the thread shows a notice on the first turn of the Pi session.
  Run the configured Pi binary in that folder on the server machine, using the same provider
  environment, including `PI_CODING_AGENT_DIR` if set. Trust the folder or its parent with `/trust`,
  then start a new thread using that same worktree. Launch arguments with `--no-approve` keep
  project files off without the notice.
- The context meter is off by default; see [commands and skills](./composer.md#commands-and-skills)
  to enable it on web and desktop. It appears once Pi reports usage for the thread. Some model
  providers only report usage when a response completes, so the meter can wait for the first reply.
