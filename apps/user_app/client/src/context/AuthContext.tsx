import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import {
  login as apiLogin,
  googleLogin as apiGoogleLogin,
  register as apiRegister,
  getMe,
  type Conversations,
  type RegisterData,
} from "../api";
import { getChatSocket, disconnectChatSocket } from "../sockets/chatSocket";

interface User {
  id: number;
  displayName: string | null;
  role: string;
  organizationName: string | null;
  organizationLogo: string | null;
}

/**
 * Metadata returned from any login flow so the caller can decide whether to
 * play the "welcome" launch animation. When `isFirstLogin` is true the
 * session is held in `pendingSessionRef` until the caller fires
 * `activateSession()` — so the animation can play on a clean login screen
 * before the authenticated app mounts.
 */
export interface LoginResult {
  isFirstLogin: boolean;
  organization: { name: string; logo: string | null } | null;
}

interface AuthContextValue {
  user: User | null;
  conversations: Conversations | null;
  setConversations: React.Dispatch<React.SetStateAction<Conversations | null>>;
  loading: boolean;
  login: (userName: string, password: string) => Promise<LoginResult>;
  loginWithGoogle: (idToken: string) => Promise<LoginResult>;
  register: (data: RegisterData) => Promise<void>;
  /** Set the user/conversations without re-registering. Call after deferred animations. */
  activateSession: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [conversations, setConversations] = useState<Conversations | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = localStorage.getItem("token");
    if (!token) {
      setLoading(false);
      return;
    }
    getMe()
      .then((me) => {
        setUser({
          id: me.id,
          displayName: me.displayName,
          role: me.role ?? "user",
          organizationName: me.organization?.name ?? null,
          organizationLogo: me.organization?.logo ?? null,
        });
        setConversations(me.conversations);
      })
      .catch(() => {
        localStorage.removeItem("token");
      })
      .finally(() => setLoading(false));
  }, []);

  // Pending session data — stored so a "welcome" animation can finish playing
  // before we set `user` (which would trigger the route redirect). Used by
  // org registration, first-time Google SSO, and first-time local password
  // login for admin-created accounts.
  const pendingSessionRef = React.useRef<{ user: User; conversations: Conversations } | null>(null);

  const login = useCallback(
    async (userName: string, password: string): Promise<LoginResult> => {
      const res = await apiLogin(userName, password);
      localStorage.setItem("token", res.token);
      const nextUser: User = {
        id: res.user.id,
        displayName: res.user.displayName,
        role: res.user.role ?? "user",
        organizationName: res.organization?.name ?? null,
        organizationLogo: res.organization?.logo ?? null,
      };
      const meta: LoginResult = {
        isFirstLogin: res.isFirstLogin === true,
        organization: res.organization
          ? { name: res.organization.name, logo: res.organization.logo }
          : null,
      };
      if (meta.isFirstLogin) {
        // Hold off on activating — the caller will play the launch animation
        // and then fire `activateSession()` to drop the user into the app.
        pendingSessionRef.current = { user: nextUser, conversations: res.conversations };
      } else {
        setUser(nextUser);
        setConversations(res.conversations);
      }
      return meta;
    },
    [],
  );

  const loginWithGoogle = useCallback(
    async (idToken: string): Promise<LoginResult> => {
      const res = await apiGoogleLogin(idToken);
      localStorage.setItem("token", res.token);
      const nextUser: User = {
        id: res.user.id,
        displayName: res.user.displayName,
        role: res.user.role ?? "user",
        organizationName: res.organization?.name ?? null,
        organizationLogo: res.organization?.logo ?? null,
      };
      const meta: LoginResult = {
        isFirstLogin: res.isFirstLogin === true,
        organization: res.organization
          ? { name: res.organization.name, logo: res.organization.logo }
          : null,
      };
      if (meta.isFirstLogin) {
        pendingSessionRef.current = { user: nextUser, conversations: res.conversations };
      } else {
        setUser(nextUser);
        setConversations(res.conversations);
      }
      return meta;
    },
    [],
  );

  const register = useCallback(async (data: RegisterData) => {
    const res = await apiRegister(data);
    localStorage.setItem("token", res.token);
    // Store but do NOT activate yet — the caller will call activateSession()
    // after any deferred UI (e.g. the cinematic launch animation) is complete.
    pendingSessionRef.current = {
      user: {
        id: res.user.id,
        displayName: res.user.displayName,
        role: res.user.role ?? "user",
        organizationName: res.organization?.name ?? null,
        organizationLogo: res.organization?.logo ?? null,
      },
      conversations: res.conversations,
    };
  }, []);

  const activateSession = useCallback(() => {
    const pending = pendingSessionRef.current;
    if (pending) {
      setUser(pending.user);
      setConversations(pending.conversations);
      pendingSessionRef.current = null;
    }
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem("token");
    disconnectChatSocket();
    setUser(null);
    setConversations(null);
  }, []);

  // Keep conversations state in sync with admin changes (always mounted)
  useEffect(() => {
    if (!user) return;
    const token = localStorage.getItem("token");
    if (!token) return;

    const socket = getChatSocket(token);

    const onAdminChange = (data: { type: string; data: any }) => {
      switch (data.type) {
        case "group_model_changed": {
          const { groupId, model } = data.data;
          setConversations((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              groups: prev.groups.map((g) =>
                g.id === groupId ? { ...g, model } : g,
              ),
            };
          });
          break;
        }
        case "single_chat_model_changed": {
          const { singleChatId, model } = data.data;
          setConversations((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              singleChats: prev.singleChats.map((sc) =>
                sc.id === singleChatId ? { ...sc, model } : sc,
              ),
            };
          });
          break;
        }
        case "group_renamed": {
          const { groupId, name } = data.data;
          setConversations((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              groups: prev.groups.map((g) =>
                g.id === groupId ? { ...g, name } : g,
              ),
            };
          });
          break;
        }
        case "group_deleted": {
          const { groupId } = data.data;
          setConversations((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              groups: prev.groups.filter((g) => g.id !== groupId),
            };
          });
          break;
        }
      }
    };

    const onConversationsUpdated = (data: any) => {
      if (data.action === "group_added" && data.group) {
        setConversations((prev) => {
          if (!prev) return prev;
          if (prev.groups.some((g: any) => g.id === data.group.id)) return prev;
          return { ...prev, groups: [...prev.groups, data.group] };
        });
      } else if (data.action === "group_removed" && data.groupId) {
        setConversations((prev) => {
          if (!prev) return prev;
          return { ...prev, groups: prev.groups.filter((g: any) => g.id !== data.groupId) };
        });
      } else if (data.action === "single_chat_added" && data.singleChat) {
        setConversations((prev) => {
          if (!prev) return prev;
          if (prev.singleChats.some((sc: any) => sc.id === data.singleChat.id)) return prev;
          return { ...prev, singleChats: [...prev.singleChats, data.singleChat] };
        });
      } else if (data.action === "agent_model_changed" && data.agentId) {
        const newModel = data.model ?? null;
        setConversations((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            singleChats: prev.singleChats.map((sc: any) =>
              sc.agentId === data.agentId ? { ...sc, model: newModel } : sc,
            ),
            groups: prev.groups.map((g: any) =>
              g.agentId === data.agentId ? { ...g, model: newModel } : g,
            ),
          };
        });
      }
    };

    socket.on("conversations:updated", onConversationsUpdated);
    socket.on("admin:change", onAdminChange);
    return () => {
      socket.off("conversations:updated", onConversationsUpdated);
      socket.off("admin:change", onAdminChange);
    };
  }, [user]);

  return (
    <AuthContext.Provider
      value={{
        user,
        conversations,
        setConversations,
        loading,
        login,
        loginWithGoogle,
        register,
        activateSession,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
