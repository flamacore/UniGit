import { create } from "zustand";

const STORAGE_KEY = "unigit.repositories";

type RepositoryStore = {
  repositories: string[];
  selectedRepository: string | null;
  addRepository: (path: string) => void;
  removeRepository: (path: string) => void;
  selectRepository: (path: string | null) => void;
};

type PersistedState = {
  repositories: string[];
  selectedRepository: string | null;
};

const loadInitialState = (): PersistedState => {
  if (typeof window === "undefined") {
    return { repositories: [], selectedRepository: null };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      return { repositories: [], selectedRepository: null };
    }

    const parsed = JSON.parse(raw) as PersistedState;

    return {
      repositories: Array.isArray(parsed.repositories) ? parsed.repositories : [],
      selectedRepository:
        typeof parsed.selectedRepository === "string"
          ? parsed.selectedRepository
          : null,
    };
  } catch {
    return { repositories: [], selectedRepository: null };
  }
};

const persistState = (state: PersistedState) => {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
};

const initialState = loadInitialState();

export const useRepositoryStore = create<RepositoryStore>((set) => ({
  repositories: initialState.repositories,
  selectedRepository: initialState.selectedRepository,
  addRepository: (path) =>
    set((state) => {
      const repositories = Array.from(new Set([path, ...state.repositories]));
      const nextState = { repositories, selectedRepository: path };
      persistState(nextState);
      return nextState;
    }),
  removeRepository: (path) =>
    set((state) => {
      const repositories = state.repositories.filter((item) => item !== path);
      const selectedRepository =
        state.selectedRepository === path
          ? repositories[0] ?? null
          : state.selectedRepository;
      const nextState = { repositories, selectedRepository };
      persistState(nextState);
      return nextState;
    }),
  selectRepository: (path) =>
    set((state) => {
      const nextState = {
        repositories: state.repositories,
        selectedRepository: path,
      };
      persistState(nextState);
      return nextState;
    }),
}));
