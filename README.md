# UniGit

UniGit is a Windows-first desktop Git client aimed at high-speed Unity and game-development workflows.

DISCLAIMER: Created with the help of AI, combining both human written code & AI written code. 

## Current slice

This first implementation slice includes:

- Tauri 2 plus React TypeScript desktop shell
- Large-screen aware UI scaling for 4K-class displays
- Viewport-contained layout with independent pane scrolling instead of a window-level scrollbar
- Local repository list persisted in the client
- Repository inspection through Git CLI
- Staged and unstaged lanes with drag-and-drop and one-click actions
- Commit composer for staged changes
- Recent history list with client-side filtering
- Detection and highlighting for files changed after staging
- Selection inspector with file metadata, exact Git diffs for text-capable files, inline text preview, and inline image preview
- Dedicated asset metadata pipeline for PSD, FBX, GLTF, and GLB files as the foundation for deeper asset rendering

## Getting started

```powershell
npm install
npm run tauri:dev
```

## Next slices

- Worker-backed rendered previews for PSD, FBX, and GLTF assets
- Commit graph renderer with richer filtering
- Local ignore management backed by repository-local exclude rules
- More destructive power commands with undo and safety refs
