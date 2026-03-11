# UniGit Implementation Summary

## Purpose

This file is the durable running summary of what has already been built, what decisions were made, what phase the project is currently in, and where the next work should continue after context compaction.

## Current phase

The project is currently in active Phase 2 with early Phase 3 preview work already underway.

- Phase 1 foundation is effectively in place.
- Phase 2 now has a first real graph foundation: paged commit-graph data, lane metadata, and a canvas-driven graph viewport.
- Phase 2 history inspection has started through graph commit selection and commit detail retrieval.
- Phase 3 remains active through the preview and inspection pipeline foundation.

## Stack and architecture

- Desktop shell: Tauri 2
- Frontend: React + TypeScript + Vite
- Backend: Rust
- Git integration strategy: Git CLI orchestration from Rust, not libgit2 yet
- Packaging target: Windows-first native desktop app
- UX stance: minimal modal friction, direct actions, inline consequences where possible

## What exists now

### Application shell

- Tauri desktop shell is configured and builds successfully.
- React frontend is structured around a compact top chrome instead of a persistent left sidebar.
- Repository switching happens through top tabs.
- The app uses a viewport-contained layout with internal pane scrolling.
- Large-screen scaling for 4K-class displays is already handled.
- User-facing status, error, and remote-operation notifications now auto-dismiss after a delay unless the pointer is hovering them.

### Repository management

- Local repositories can be added from a folder picker.
- Repositories are persisted locally in browser storage on the frontend side.
- Repositories can be selected and removed from the tab strip.
- A repository manager dialog now exists for clone, open-existing, and per-repository settings.
- The repository manager is also the enforced entry surface when no repositories are loaded.
- Repository settings now surface current branch, repository path, and configured remotes.
- Repository clone now exists through the app via a backend Git clone command.

### Git backend

- Repository inspection command exists in Rust.
- Commit history listing exists in Rust.
- Commit graph paging exists and now returns lane-aware graph rows in pages instead of a single small list.
- Commit detail inspection exists and returns commit metadata plus changed files for a selected commit.
- Export-from-commit and restore-from-commit actions now exist for files listed in the selected commit inspector.
- File history inspection now exists for the selected working-tree file.
- File-level patch application and reverse patch application now exist from file history entries.
- Push now exists as a first-class top-bar remote action.
- Normal pull now exists as a first-class top-bar remote action.
- Normal pull now auto-detects divergence and falls back to a merge-based pull instead of failing on diverged local and remote history.
- A first guarded force-pull action now exists with an inline consequence summary and safety ref creation.
- Push and force-pull outcomes now surface through a dedicated inline remote dialog with clearer failure reasons instead of relying only on the generic error banner.
- The refresh control now performs a real fetch so ahead/behind state and remote refs can update from the server instead of only rereading local status.
- A persistent verbose application log now records frontend action events plus backend Git command execution details.
- Branch listing, switching, renaming, and deletion commands now exist for local and remote branches.
- Stage files command exists.
- Unstage files command exists.
- Commit command exists.
- All of these are invoked from the frontend through Tauri commands.

### Logging

- The app now writes a persistent log file to the local app data folder at `UniGit/logs/unigit.log`.
- The log includes frontend action events, remote-operation outcomes, and verbose Git command start, success, and failure entries.

### Working tree UI

- Two-lane changes view exists: unstaged and staged.
- Drag-and-drop between lanes exists.
- One-click stage and unstage buttons exist.
- Shift-click and Ctrl/Cmd-click multi-select now exist in the change lanes.
- The unstaged lane now supports Stage selected and Stage all bulk actions.
- Commit box exists.
- Files changed after staging are detected and surfaced in status logic.

### Change list behavior

- Change rows now use a left-side colored marker instead of plain text status labels.
- Marker semantics currently include changed, changed-after-staging, removed, moved or renamed, added or untracked, and conflict.
- File entries no longer rely on hard truncation alone.
- Paths can wrap responsively when shown.
- There are controls to filter the list.
- There are controls to show or hide paths.
- There are controls to sort by name, folder, extension, or status.
- Sort direction can be toggled.
- `.meta` files are treated specially.
- If a file and its `.meta` partner both exist in the same lane, the `.meta` file is always listed directly under the source file regardless of sorting or filtering.
- `.meta` entries are rendered with reduced visual emphasis.

### Selection inspector and preview foundation

- The selection inspector loads metadata for the selected file.
- Inline text preview exists.
- Inline image preview exists.
- Exact staged and unstaged Git diffs exist for text-capable files.
- Diff block now appears before the raw preview block.
- Diff lines are highlighted with semantic backgrounds:
  - additions in green
  - removals in red
  - hunk headers styled separately
  - file headers styled separately

### Asset preview foundation

- Preview command returns structured metadata for asset-oriented files.
- PSD header parsing exists.
- FBX basic container or version detection exists.
- GLTF summary parsing exists.
- GLB container summary parsing exists.
- Current asset handling is metadata-first; true rendered asset previews are not built yet.

### History UI and graph foundation

- The previous stacked history list has been replaced by a dedicated middle graph viewport.
- The graph area is now split with a resizable branch-management pane on the left and the commit graph on the right.
- The graph now renders on a real canvas-backed surface instead of using lane markers inside list rows.
- Commit nodes and lane tracks are colorized per lane.
- Merge commits are visually distinct from regular commits.
- The graph now uses an inline git-log style row layout beside the lane block rather than floating commit cards.
- The graph viewport supports both horizontal and vertical scrolling.
- The graph viewport supports fullscreen mode for inspection.
- The graph fetch path is paged so the UI does not need to request only a tiny fixed slice.
- The graph feed is currently date-ordered for more intuitive historical reading while retaining branch structure.
- The graph viewport now includes live controls for lane scaling and lane-block width cropping.
- The graph rows are rendered through a translated virtualized row container instead of individually positioned overlays.
- Graph scrollbar styling has been themed to match the rest of the application.
- Graph rows are now selectable.
- Selecting a commit loads a commit inspector with metadata and a per-commit changed-file list.
- Selected commit files can now be exported from that commit or restored into the working tree.
- Selecting a working-tree file now also loads recent file history in the inspector.
- File history entries can open the commit inspector, export that file version, restore it, apply that commit's file patch, or reverse it.
- The top bar now includes a real push button and an initial force-pull control.
- The new branch pane lists local and remote branches, supports click selection, right-click branch actions, branch switching, inline rename for local branches, and deletion for local or remote branches.
- The branch pane now supports fullscreen mode independently of the commit graph.
- Branches in the pane are now grouped into a slash-segment tree with fold and unfold behavior, so names like `task/xyz` appear under their shared folder path.
- The current graph is still an initial scalable foundation rather than the final enterprise graph engine.

## Major UX corrections already made

These were explicitly corrected during iteration:

- Removed bloated number panels for staged, unstaged, and related counts from the main layout.
- Removed the unnecessary permanent left pane.
- Reworked the shell to be denser and less amateur-looking.
- Reduced typography size and excessive spacing.
- Fixed overflows and broken wrapping in the file list.
- Changed scrolling model from whole-window scroll to contained internal scrolling.
- Reordered diff and preview so diff is presented first.

## Files that matter most right now

### Frontend

- `src/app/App.tsx`
  - Main shell, repo tabs, list controls, graph integration, selection inspector for both working-tree files and selected commits, diff-first inspector ordering
- `src/app/CommitGraphCanvas.tsx`
  - Canvas-backed commit graph viewport, inline graph rows, commit selection, scale and lane-width controls, fullscreen toggle, and graph paging integration
- `src/styles.css`
  - Entire UI system, density, layout, scrolling behavior, change markers, diff highlighting, graph viewport styling
- `src/features/repositories/api.ts`
  - Frontend types and Tauri invoke wrappers
- `src/features/repositories/store/useRepositoryStore.ts`
  - Local repo persistence and selection state
- `src/lib/tauri.ts`
  - Tauri environment helper

### Backend

- `src-tauri/src/main.rs`
  - Tauri command registration
- `src-tauri/src/git/service.rs`
  - Git CLI orchestration, repository inspection, paged commit graph extraction, commit detail retrieval, commit/stage/unstage, preview data, diff extraction, asset metadata parsing
- `src-tauri/src/git/models.rs`
  - Shared Rust-side response models including paged graph and commit detail responses
- `src-tauri/Cargo.toml`
  - Rust dependencies
- `src-tauri/tauri.conf.json`
  - Tauri configuration

## Validation status

These commands have been run successfully multiple times:

- `npm run build`
- `cargo check --manifest-path src-tauri/Cargo.toml`

The app has also been run through Tauri dev during iteration.

## What is not done yet

- Cross-lane merge connector refinement and deeper branch topology rendering
- Rich history query engine beyond client-side filtering of loaded pages
- File tree per commit beyond the changed-file list
- Richer file tree and commit browsing beyond the current changed-file list and file-history summary
- Branch-scoped graph views, ancestry focus, and path history overlays
- Rendered PSD preview
- Embedded GLTF/FBX viewer
- Local ignore layer
- Destructive power commands
- Remote management depth
- Undo and safety ref system
- Merge conflict editor

## Recommended next step

Next focus should be the real commit graph phase.

That means:

1. Improve merge connector routing and branch continuity in the graph canvas.
2. Extend the new commit inspector into full file-level history actions, starting with restore and export from selected commits.
3. Extend backend graph paging to support branch, author, and path-oriented queries.
4. Add stronger graph navigation for gigantic repositories, including jump, focus, and branch-scoped views.

## Notes for future continuation

- Do not reintroduce metric-card bloat unless it becomes optional and genuinely useful.
- Preserve `.meta` pairing semantics no matter how list filtering and sorting evolve.
- Keep diff before preview in the inspector.
- Keep the UI dense and functional rather than decorative.
