import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(undefined); // undefined = still loading

  const refresh = useCallback(async () => {
    try {
      setUser((await api.get('/api/auth/me')).user);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    refresh();
    setUnauthorizedHandler(() => setUser(null));
  }, [refresh]);

  const login = async (email, password) => {
    const { user } = await api.post('/api/auth/login', { email, password });
    setUser(user);
    return user;
  };
  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => {});
    setUser(null);
  };

  return <AuthContext.Provider value={{ user, setUser, refresh, login, logout }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

export const homeFor = (user) => (user?.role === 'ADMIN' ? '/admin' : user?.role === 'SECURITY' ? '/gate' : '/');
