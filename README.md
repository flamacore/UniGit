# UniGit

[Buy Me a Coffee](https://buymeacoffee.com/chao.k)

<img width="1354" height="939" alt="unigit_Wb3Dkb9u2E" src="https://github.com/user-attachments/assets/43d133fe-52f2-4e96-af0d-9f7227c0185d" />

UniGit is a Windows-first desktop Git client built for fast day-to-day work, with a strong focus on game development and Unity-heavy repositories.

It is designed around a dense single-window workflow: inspect changes, manage branches, review history, generate commit messages, preview assets, and push or pull without bouncing through a pile of dialogs.

## Why It Stands Out

- ### Preview images, Unity materials, and 3D assets inline inside the Git workflow rather than switching out to separate tools
- ### Compare working tree, staged, and `HEAD` asset states for supported preview types
- ### META file pairing specifically for Unity projects where your meta files always get the same action so you won't ever say "sorry forgot to push the meta change" 
- ### Local, app-level local ignore that will keep changes you want to ignore but don't want to change the actual .gitignore
- ### Work comfortably with Unity-heavy repos, including Unity meta pairing and material-focused inspection flows
- ### Deliberate destructive actions allowing you to discard local conflicted files while switching/pulling/checking out or other operations
- ### AI generated commit message support via OpenAI, Claude or Ollama API

<img width="627" height="463" alt="unigit_ZV3YP462rC" src="https://github.com/user-attachments/assets/82ee0d91-32ce-4cd1-a207-f0bf5729a474" />
<img width="612" height="447" alt="unigit_WGWal5s5yd" src="https://github.com/user-attachments/assets/ff0a0cdd-6530-4230-8f31-cedd4d765b94" />
<img width="792" height="240" alt="unigit_D6TjlvYOhY" src="https://github.com/user-attachments/assets/a81bd61b-57da-4c9f-bb79-ec4d4feb7648" />



## What It Does

- Stage and unstage files with drag-and-drop and bulk actions
- Review exact staged and unstaged diffs in the inspector, including expanded diff viewing for selected files
- Browse a canvas-backed commit graph with branch and commit inspection
- Manage local and remote branches, including switch, force switch, merge, rename, and delete flows
- Create AI-assisted commit messages from staged changes and local unpushed commit context
- Preview text, images, PSD files, Unity `.mat` materials, and 3D assets such as FBX, OBJ, GLTF, and GLB
- Inspect Unity materials on sphere, box, or cylinder meshes, with preview/text switching and diff-aware workflows
- Orbit and compare supported 3D model previews with auto-centered preview pivots for awkward source assets
- Clone repositories, manage remotes, and work from a compact tab-based multi-repo layout

## Current Status

UniGit is already usable for real repository work and is actively being developed.

Today the app includes:

- Tauri 2 desktop shell with React, TypeScript, and Rust
- Git CLI orchestration from the Rust backend
- Working tree lanes for staged and unstaged changes
- Commit graph, commit inspector, exact file diff inspection, and file history actions
- Branch management workflows and inline remote-operation feedback
- AI-powered commit message generation through Ollama, OpenAI, or Claude
- Asset preview workflows for images, PSD, Unity materials, and common 3D formats
- Fullscreen inspector tools for deeper file review without leaving the main client

Still in progress:

- Richer merge conflict handling
- Deeper commit graph refinement for very large repositories
- Broader asset-format coverage and deeper format-specific rendering
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
