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

Run `tenet` inside your Claude Code project (or pass `-t` to point at one):

```sh
tenet                              # 3 rounds, 3 exchanges each
tenet -r 5 -e 4                    # 5 rounds, 4 exchanges each
tenet -t ~/my-project --verbose    # target a different project, show transcripts
tenet --dry-run                    # scan + generate first mission only
```

**Options:**

| Flag | Description | Default |
|------|-------------|---------|
| `-r, --rounds <n>` | Number of competition rounds | 3 |
| `-e, --max-exchanges <n>` | Max conversation turns per red team session | 3 |
| `-t, --target <path>` | Target project path | current directory |
| `-v, --verbose` | Show full session transcripts | off |
| `--dry-run` | Scan and generate first mission only | off |

## Contributing

PRs and issues are welcome — open one at [github.com/Positive-LLC/claude-tenet](https://github.com/Positive-LLC/claude-tenet).
