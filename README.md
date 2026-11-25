# My personal Pi agent extensions

No custom extensions at the moment. Third-party packages in use:

```bash
pi install npm:@narumitw/pi-goal                     # /goal: keep working until an objective is met
pi install npm:@juicesharp/rpiv-ask-user-question    # ask_user_question: structured clarifying questions
pi install npm:@tintinweb/pi-subagents              # Agent tool: subagents, FleetView, workflows
pi install npm:pi-context-view                       # /context: see what fills the context window
pi install npm:@ian-pascoe/pi-lsp                    # LSP tools + diagnostics appended after every edit
```

## LSP setup (`@ian-pascoe/pi-lsp`)

Language servers are not bundled; install them yourself (`go install golang.org/x/tools/gopls@latest`)
and add them under the `lsp` key in `~/.pi/agent/settings.json`:

```json
{
  "lsp": {
    "servers": {
      "gopls": {
        "command": "gopls",
        "languages": [{ "extensions": [".go"], "languageId": "go" }],
        "rootMarkers": ["go.mod", "go.work"],
        "requireRootMarker": true,
        "initializationOptions": { "pullDiagnostics": true }
      }
    }
  }
}
```

`pullDiagnostics: true` is required: without it gopls (checked with v0.24.0) only pushes diagnostics,
and pi-lsp's automatic post-edit diagnostics stay silent for Go files. Run `/lsp` to check server status.
