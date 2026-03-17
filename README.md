# UniGit

<!-- Add main app image here for GitHub -->

[Buy Me a Coffee](https://buymeacoffee.com/chao.k)

UniGit is a Windows-first desktop Git client built for fast day-to-day work, with a strong focus on game development and Unity-heavy repositories.

It is designed around a dense single-window workflow: inspect changes, manage branches, review history, generate commit messages, and push or pull without bouncing through a pile of dialogs.

## What It Does

- Stage and unstage files with drag-and-drop and bulk actions
- Review exact staged and unstaged diffs in the inspector
- Browse a canvas-backed commit graph with branch and commit inspection
- Manage local and remote branches, including switch, force switch, merge, rename, and delete flows
- Create AI-assisted commit messages from staged changes and local unpushed commit context
- Preview text, images, and asset metadata for formats like PSD, FBX, GLTF, and GLB
- Clone repositories, manage remotes, and work from a compact tab-based multi-repo layout

## Current Status

UniGit is already usable for real repository work and is actively being developed.

Today the app includes:

- Tauri 2 desktop shell with React, TypeScript, and Rust
- Git CLI orchestration from the Rust backend
- Working tree lanes for staged and unstaged changes
- Commit graph, commit inspector, and file history actions
- Branch management workflows and inline remote-operation feedback
- AI-powered commit message generation through Ollama, OpenAI, or Claude

Still in progress:

- Richer merge conflict handling
- Deeper commit graph refinement for very large repositories
- Rendered asset previews beyond metadata-first inspection
- More advanced history queries and navigation tools

## Getting Started

```powershell
npm install
npm run tauri dev
```

You will also need:

- Git available on your system `PATH`
- A Windows environment for the current primary development target

## Tech Stack

- Tauri 2
- React
- TypeScript
- Rust
- Vite
