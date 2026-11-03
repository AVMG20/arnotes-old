// What a person pastes on an agent's machine to connect it to this install. One copy, used by
// Settings → API keys & MCP and by Settings → Sprocket, so the two never drift apart.

/** The kit unpacks without a folder of its own, so it gets one. */
export function crewKitCommands(origin: string): string {
  return [
    'mkdir -p ~/crew-kit ~/.claude/skills/taskmanager-crew',
    `curl -fsSL ${origin}/crew/kit.tar.gz | tar -xz -C ~/crew-kit`,
    `curl -fsSL ${origin}/crew/SKILL.md -o ~/.claude/skills/taskmanager-crew/SKILL.md`,
    'cd ~/crew-kit && npm install'
  ].join('\n')
}

/** Written by the shell, so $HOME is the agent machine's own. `pm` is the member. */
export function crewChannelCommand(): string {
  return `cat > .mcp.json <<EOF
{
  "mcpServers": {
    "taskmanager-crew": {
      "command": "node",
      "args": ["$HOME/crew-kit/channel.mjs", "pm"],
      "env": { "CREW_HOME": "$HOME/crew-home" }
    }
  }
}
EOF
claude --dangerously-load-development-channels server:taskmanager-crew`
}

// The key travels in the environment: the shell fills it in, so an agent running these
// commands never reads, types or prints it.
export const KEY_VARIABLE = 'TASKMANAGER_API_KEY'

/** The line a person runs once, in the terminal the agent will be started from. */
export function exportKeyCommand(token = 'arn_your_key_here'): string {
  return `export ${KEY_VARIABLE}=${token}`
}

export function mcpAddCommand(origin: string): string {
  return `claude mcp add --transport http taskmanager ${origin}/api/mcp \\\n  --header "Authorization: Bearer $${KEY_VARIABLE}"`
}

/** Every step at once, as instructions to paste into a Claude Code session. */
export function agentInstructions(origin: string): string {
  return `Set yourself up to work with my Taskmanager at ${origin}.

The API key is in your environment as $${KEY_VARIABLE}. Use it only as that variable,
so the shell fills it in: never echo it, print it or write its value anywhere yourself.
If it is not set, stop and ask me to run \`${exportKeyCommand('<my key>')}\` and start you again.

1. Connect its MCP server:
   claude mcp add --transport http taskmanager ${origin}/api/mcp --header "Authorization: Bearer $${KEY_VARIABLE}"
2. Install the crew kit and its skill:
${crewKitCommands(origin).split('\n').map(line => `   ${line}`).join('\n')}
3. Read ~/crew-kit/README.md and take me through "A provisioned crew" if I want to run a crew.
   The crew's home folder is ~/crew-home (CREW_HOME); creds.json goes there, never into a repository.
4. For crew channels, put a .mcp.json in the folder a crew member's session starts from, as the
   README's "Channels" section shows, with the full paths of ~/crew-kit/channel.mjs and ~/crew-home.

Ask me for anything you need, and never print the key or creds.json.`
}
