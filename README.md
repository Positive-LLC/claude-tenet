# claude-tenet

Adversarial testing framework for Claude Code agent projects. It runs automated red team vs blue team simulations to find and fix issues in your agent's markdown configuration — CLAUDE.md, skills, commands, hooks, MCP servers, and more.

## Prerequisites

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- Logged in via `claude` or have `ANTHROPIC_API_KEY` set in your environment

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/Positive-LLC/claude-tenet/main/install.sh | sh
```

This installs the latest release to `~/.local/bin/tenet`. Run it again anytime to update. Set `TENET_INSTALL_DIR` to change the install location.

## Usage

Tenet has two test modes, run as subcommands:

- **`integration`** (default) — Does the parent agent call each component smoothly?
- **`unit`** — Does each component handle diverse scenarios, edge cases, and traps correctly?

```sh
tenet                              # integration test, 3 rounds, 3 exchanges each
tenet integration -r 5 -e 4       # 5 rounds, 4 exchanges each
tenet unit -t ~/my-project         # unit test each component in isolation
tenet unit -r 3 -e 5 --verbose    # thorough unit tests with transcripts
tenet --dry-run                    # scan + generate first mission only
```

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `-r, --rounds <n>` | Number of rounds (per component in unit mode) | 3 |
| `-e, --max-exchanges <n>` | Max conversation turns per red team session | 3 |
| `-t, --target <path>` | Target project path | current directory |
| `-v, --verbose` | Show full session transcripts | off |
| `--dry-run` | Scan and generate first mission only | off |

### Integration vs Unit

**Integration** tests the full agent end-to-end: the red team sends realistic requests and checks whether the right components get invoked and linked together correctly.

**Unit** tests each component in isolation: tenet creates a sandbox with just the target component and its dependencies, then pressure-tests it with edge cases, adversarial inputs, and boundary conditions. An LLM ownership analysis determines which agent owns each tool component and what dependencies to include. Fixes are synced back to the original project after each component.

## Contributing

PRs and issues are welcome — open one at [github.com/Positive-LLC/claude-tenet](https://github.com/Positive-LLC/claude-tenet).
