import { type MouseEvent, useCallback, useEffect, useMemo, useState } from "react";
import type { FileChange } from "../../features/repositories/api";
import type {
  ChangeContextMenuState,
  ChangeListItem,
  ChangeSortKey,
  HiddenLocalContextMenuState,
  HiddenLocalEntry,
  LocalIgnoreMap,
} from "../types";
import { buildChangeList } from "../utils/changeList";
import { loadLocalIgnoreMap, persistLocalIgnoreMap } from "../utils/localIgnore";

type UseChangeWorkbenchArgs = {
  snapshotFiles: FileChange[] | undefined;
  selectedRepository: string | null;
  changeQuery: string;
  showPaths: boolean;
  sortBy: ChangeSortKey;
  sortDirection: "asc" | "desc";
  pairMetaFiles: boolean;
  setStatusMessage: (message: string | null) => void;
};

export function useChangeWorkbench({
  snapshotFiles,
  selectedRepository,
  changeQuery,
  showPaths,
  sortBy,
  sortDirection,
  pairMetaFiles,
  setStatusMessage,
}: UseChangeWorkbenchArgs) {
  const [selectedChangePath, setSelectedChangePath] = useState<string | null>(null);
  const [selectedChangePaths, setSelectedChangePaths] = useState<string[]>([]);
  const [selectionAnchorPath, setSelectionAnchorPath] = useState<string | null>(null);
  const [localIgnoreMap, setLocalIgnoreMap] = useState<LocalIgnoreMap>(() => loadLocalIgnoreMap());
  const [changeContextMenu, setChangeContextMenu] = useState<ChangeContextMenuState | null>(null);
  const [selectedHiddenLocalKeys, setSelectedHiddenLocalKeys] = useState<string[]>([]);
  const [hiddenLocalAnchorKey, setHiddenLocalAnchorKey] = useState<string | null>(null);
  const [hiddenLocalContextMenu, setHiddenLocalContextMenu] = useState<HiddenLocalContextMenuState | null>(null);

  useEffect(() => {
    persistLocalIgnoreMap(localIgnoreMap);
  }, [localIgnoreMap]);

  const hiddenLocalKeys = useMemo(() => {
    if (!selectedRepository) {
      return new Set<string>();
    }

    return new Set(localIgnoreMap[selectedRepository] ?? []);
  }, [localIgnoreMap, selectedRepository]);

  const changeListOptions = useMemo(
    () => ({
      query: changeQuery,
      showPaths,
      sortBy,
      sortDirection,
    }),
    [changeQuery, showPaths, sortBy, sortDirection],
  );

  const unstagedChanges = useMemo(
    () => buildChangeList(snapshotFiles ?? [], "unstaged", changeListOptions, pairMetaFiles, hiddenLocalKeys),
    [changeListOptions, hiddenLocalKeys, pairMetaFiles, snapshotFiles],
  );

  const stagedChanges = useMemo(
    () => buildChangeList(snapshotFiles ?? [], "staged", changeListOptions, pairMetaFiles, hiddenLocalKeys),
    [changeListOptions, hiddenLocalKeys, pairMetaFiles, snapshotFiles],
  );

  const allVisibleChangeItems = useMemo(
    () => [...unstagedChanges, ...stagedChanges],
    [stagedChanges, unstagedChanges],
  );

  const visibleChangeItemMap = useMemo(
    () => new Map(allVisibleChangeItems.map((item) => [item.selectionKey, item])),
    [allVisibleChangeItems],
  );

  const resolveActionPathsForSelection = useCallback((selectionKeys: string[]) => {
    return Array.from(
      new Set(
        selectionKeys.flatMap((selectionKey) => visibleChangeItemMap.get(selectionKey)?.actionPaths ?? []),
      ),
    );
  }, [visibleChangeItemMap]);

  const resolveHiddenKeysForSelection = useCallback((selectionKeys: string[]) => {
    return Array.from(
      new Set(
        selectionKeys.flatMap((selectionKey) => {
          const item = visibleChangeItemMap.get(selectionKey);
          return item ? [item.hiddenKey] : [];
        }),
      ),
    );
  }, [visibleChangeItemMap]);

  useEffect(() => {
    setSelectedChangePaths((current) => {
      const next = current.filter((selectionKey) => visibleChangeItemMap.has(selectionKey));
      return next.length === current.length && next.every((value, index) => value === current[index])
        ? current
        : next;
    });

    if (selectedChangePath && !visibleChangeItemMap.has(selectedChangePath)) {
      setSelectedChangePath(null);
    }
  }, [selectedChangePath, visibleChangeItemMap]);

  const resolveContextSelectionKeys = useCallback((item: ChangeListItem) => {
    if (selectedChangePaths.includes(item.selectionKey)) {
      return selectedChangePaths;
    }

    return [item.selectionKey];
  }, [selectedChangePaths]);

  const openChangeContextMenu = useCallback((item: ChangeListItem, lane: "staged" | "unstaged", event: MouseEvent<HTMLElement>) => {
    event.preventDefault();

    if (!selectedChangePaths.includes(item.selectionKey)) {
      setSelectedChangePaths([item.selectionKey]);
      setSelectedChangePath(item.selectionKey);
      setSelectionAnchorPath(item.selectionKey);
    }

    setChangeContextMenu({
      item,
      lane,
      x: event.clientX,
      y: event.clientY,
    });
  }, [selectedChangePaths]);

  useEffect(() => {
    if (!changeContextMenu) {
      return;
    }

    const handlePointerDown = () => {
      setChangeContextMenu(null);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [changeContextMenu]);

  const selectedChange = useMemo(
    () => snapshotFiles?.find((file) => file.path === selectedChangePath) ?? null,
    [selectedChangePath, snapshotFiles],
  );

  const handleSelectChange = useCallback(
    (path: string, event: MouseEvent<HTMLElement>, orderedPaths: string[]) => {
      const withPath = (paths: string[]) => (paths.includes(path) ? paths : [...paths, path]);
      const isToggle = event.ctrlKey || event.metaKey;
      const isRange = event.shiftKey && selectionAnchorPath;

      if (isRange && selectionAnchorPath) {
        const startIndex = orderedPaths.indexOf(selectionAnchorPath);
        const endIndex = orderedPaths.indexOf(path);

        if (startIndex !== -1 && endIndex !== -1) {
          const [from, to] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
          const range = orderedPaths.slice(from, to + 1);
          setSelectedChangePaths(range);
          setSelectedChangePath(path);
          return;
        }
      }

      if (isToggle) {
        setSelectedChangePaths((current) => {
          const next = current.includes(path)
            ? current.filter((entry) => entry !== path)
            : [...current, path];

          if (next.length === 0) {
            setSelectedChangePath(null);
          } else {
            setSelectedChangePath(path);
          }

          return next;
        });
        setSelectionAnchorPath(path);
        return;
      }

      setSelectedChangePaths(withPath([path]));
      setSelectedChangePath(path);
      setSelectionAnchorPath(path);
    },
    [selectionAnchorPath],
  );

  const selectedUnstagedPaths = useMemo(() => {
    const lanePaths = new Set(unstagedChanges.map((item) => item.selectionKey));
    return selectedChangePaths.filter((path) => lanePaths.has(path));
  }, [selectedChangePaths, unstagedChanges]);

  const selectedStagedPaths = useMemo(() => {
    const lanePaths = new Set(stagedChanges.map((item) => item.selectionKey));
    return selectedChangePaths.filter((path) => lanePaths.has(path));
  }, [selectedChangePaths, stagedChanges]);

  const hideLocally = useCallback((hiddenKeys: string[]) => {
    if (!selectedRepository || hiddenKeys.length === 0) {
      return;
    }

    setLocalIgnoreMap((current) => {
      const nextKeys = Array.from(new Set([...(current[selectedRepository] ?? []), ...hiddenKeys]));
      return {
        ...current,
        [selectedRepository]: nextKeys,
      };
    });
    setSelectedChangePath(null);
    setSelectedChangePaths([]);
    setStatusMessage(`Hidden ${hiddenKeys.length} item${hiddenKeys.length > 1 ? "s" : ""} locally.`);
  }, [selectedRepository, setStatusMessage]);

  const restoreHiddenLocalKeys = useCallback((hiddenKeys: string[]) => {
    if (!selectedRepository || hiddenKeys.length === 0) {
      return;
    }

    const hiddenSet = new Set(hiddenKeys);
    setLocalIgnoreMap((current) => ({
      ...current,
      [selectedRepository]: (current[selectedRepository] ?? []).filter((entry) => !hiddenSet.has(entry)),
    }));
    setSelectedHiddenLocalKeys((current) => current.filter((entry) => !hiddenSet.has(entry)));
    setStatusMessage(`Restored ${hiddenKeys.length} locally hidden item${hiddenKeys.length > 1 ? "s" : ""}.`);
  }, [selectedRepository, setStatusMessage]);

  const hiddenLocalEntries = useMemo(() => {
    if (!selectedRepository) {
      return [];
    }

    return (localIgnoreMap[selectedRepository] ?? []).map((key) => ({
      key,
      label: key.replace(/^pair:|^file:/, ""),
    }));
  }, [localIgnoreMap, selectedRepository]);

  useEffect(() => {
    const visibleKeys = new Set(hiddenLocalEntries.map((entry) => entry.key));
    setSelectedHiddenLocalKeys((current) => current.filter((key) => visibleKeys.has(key)));

    if (hiddenLocalAnchorKey && !visibleKeys.has(hiddenLocalAnchorKey)) {
      setHiddenLocalAnchorKey(null);
    }
  }, [hiddenLocalAnchorKey, hiddenLocalEntries]);

  const handleSelectHiddenLocal = useCallback((key: string, event: MouseEvent<HTMLElement>, orderedKeys: string[]) => {
    const isToggle = event.ctrlKey || event.metaKey;
    const isRange = event.shiftKey && hiddenLocalAnchorKey;

    if (isRange && hiddenLocalAnchorKey) {
      const startIndex = orderedKeys.indexOf(hiddenLocalAnchorKey);
      const endIndex = orderedKeys.indexOf(key);

      if (startIndex !== -1 && endIndex !== -1) {
        const [from, to] = startIndex < endIndex ? [startIndex, endIndex] : [endIndex, startIndex];
        setSelectedHiddenLocalKeys(orderedKeys.slice(from, to + 1));
        return;
      }
    }

    if (isToggle) {
      setSelectedHiddenLocalKeys((current) => current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key]);
      setHiddenLocalAnchorKey(key);
      return;
    }

    setSelectedHiddenLocalKeys([key]);
    setHiddenLocalAnchorKey(key);
  }, [hiddenLocalAnchorKey]);

  const resolveHiddenLocalSelection = useCallback((entry: HiddenLocalEntry) => {
    return selectedHiddenLocalKeys.includes(entry.key) ? selectedHiddenLocalKeys : [entry.key];
  }, [selectedHiddenLocalKeys]);

  const openHiddenLocalContextMenu = useCallback((entry: HiddenLocalEntry, event: MouseEvent<HTMLElement>) => {
    event.preventDefault();

    if (!selectedHiddenLocalKeys.includes(entry.key)) {
      setSelectedHiddenLocalKeys([entry.key]);
      setHiddenLocalAnchorKey(entry.key);
    }

    setHiddenLocalContextMenu({
      entry,
      x: event.clientX,
      y: event.clientY,
    });
  }, [selectedHiddenLocalKeys]);

  useEffect(() => {
    if (!hiddenLocalContextMenu) {
      return;
    }

    const handlePointerDown = () => {
      setHiddenLocalContextMenu(null);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [hiddenLocalContextMenu]);

  return {
    changeContextMenu,
    setChangeContextMenu,
    handleSelectChange,
    handleSelectHiddenLocal,
    hiddenLocalContextMenu,
    hiddenLocalEntries,
    hideLocally,
    openChangeContextMenu,
    openHiddenLocalContextMenu,
    resolveActionPathsForSelection,
    resolveContextSelectionKeys,
    resolveHiddenKeysForSelection,
    resolveHiddenLocalSelection,
    restoreHiddenLocalKeys,
    selectedChange,
    selectedChangePath,
    selectedChangePaths,
    selectionAnchorPath,
    selectedHiddenLocalKeys,
    selectedStagedPaths,
    selectedUnstagedPaths,
    setHiddenLocalContextMenu,
    setSelectedChangePath,
    setSelectedChangePaths,
    setSelectionAnchorPath,
    stagedChanges,
    unstagedChanges,
  };
}