// Storage adapter. Swap this object for a shared backend later without touching the model.
const KEY = 'sat-architecture-mapper';

export const localStore = {
  load() {
    try {
      const text = localStorage.getItem(KEY);
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  },
  save(doc) {
    try {
      localStorage.setItem(KEY, JSON.stringify(doc));
    } catch {
      // Storage unavailable (private mode, quota): the app keeps working without it.
    }
  },
};
