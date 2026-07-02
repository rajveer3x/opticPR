import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import { useDispatch, useSelector } from "react-redux";

import { useGetCurrentUserQuery } from "@/store/api";
import { clearCredentials, setCredentials, setUser } from "@/store/authSlice";
import type { AppDispatch, RootState } from "@/store";
import type { AuthResponse, User } from "@/types/api";

interface AuthContextValue {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (response: AuthResponse) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const dispatch = useDispatch<AppDispatch>();
  const { token, user } = useSelector((state: RootState) => state.auth);
  const { data, isLoading, isError } = useGetCurrentUserQuery(undefined, {
    skip: token === null || user !== null,
  });

  useEffect(() => {
    if (data !== undefined) dispatch(setUser(data));
  }, [data, dispatch]);

  useEffect(() => {
    if (isError) {
      localStorage.removeItem("opticpr_token");
      dispatch(clearCredentials());
    }
  }, [dispatch, isError]);

  const login = useCallback(
    (response: AuthResponse) => {
      localStorage.setItem("opticpr_token", response.token);
      dispatch(setCredentials(response));
    },
    [dispatch],
  );

  const logout = useCallback(() => {
    localStorage.removeItem("opticpr_token");
    dispatch(clearCredentials());
  }, [dispatch]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      isAuthenticated: token !== null,
      isLoading: token !== null && user === null && isLoading,
      login,
      logout,
    }),
    [isLoading, login, logout, token, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);

  if (context === undefined) throw new Error("useAuth must be used within AuthProvider");

  return context;
}
