import { create } from 'zustand';
import { api, setUnauthorizedHandler, type AuthStatus } from '@/lib/api';

interface AuthState {
  status: AuthStatus | null;
  /** Re-reads auth status from the server. */
  refresh(): Promise<AuthStatus | null>;
  set(status: AuthStatus): void;
}

export const useAuth = create<AuthState>((set) => ({
  status: null,
  async refresh() {
    try {
      const status = await api.authStatus();
      set({ status });
      return status;
    } catch {
      return null;
    }
  },
  set: (status) => set({ status }),
}));

// Any 401 means the session expired or was revoked.
setUnauthorizedHandler(() => void useAuth.getState().refresh());
