import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Child } from '../../shared/types';
import { NetworkError, api, onAuthRequired } from './api';

export interface SystemStatus {
  appName: string;
  needsSetup: boolean;
  restoreAvailable: boolean;
  restorePreview: { children: number; photos: number; exportedAt: string } | null;
  authEnabled: boolean;
  authed: boolean;
  photosRoot: string;
}

interface AppState {
  status: SystemStatus | null;
  children: Child[];
  loading: boolean;
  unreachable: boolean;
  needsLogin: boolean;
  refresh: () => Promise<void>;
  setNeedsLogin: (v: boolean) => void;
}

const Ctx = createContext<AppState>(null!);

export function AppStateProvider({ children: node }: { children: ReactNode }) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [children, setChildren] = useState<Child[]>([]);
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await api<SystemStatus>('/api/system/status');
      setStatus(s);
      setUnreachable(false);
      if (s.authEnabled && !s.authed) {
        setNeedsLogin(true);
        setChildren([]);
      } else {
        setNeedsLogin(false);
        if (!s.needsSetup) setChildren(await api<Child[]>('/api/children'));
      }
    } catch (err) {
      if (err instanceof NetworkError) setUnreachable(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return onAuthRequired(() => setNeedsLogin(true));
  }, [refresh]);

  return (
    <Ctx.Provider value={{ status, children, loading, unreachable, needsLogin, refresh, setNeedsLogin }}>
      {node}
    </Ctx.Provider>
  );
}

export const useAppState = () => useContext(Ctx);
