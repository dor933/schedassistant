import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import {
  login as apiLogin,
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
}

interface AuthContextValue {
  user: User | null;
  conversations: Conversations | null;
  setConversations: React.Dispatch<React.SetStateAction<Conversations | null>>;
  loading: boolean;
  login: (userName: string, password: string) => Promise<void>;
  register: (data: RegisterData) => Promise<void>;
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
        setUser({ id: me.id, displayName: me.displayName, role: me.role ?? "user" });
        setConversations(me.conversations);
      })
      .catch(() => {
        localStorage.removeItem("token");
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (userName: string, password: string) => {
    const res = await apiLogin(userName, password);
    localStorage.setItem("token", res.token);
    setUser({ id: res.user.id, displayName: res.user.displayName, role: res.user.role ?? "user" });
    setConversations(res.conversations);
  }, []);

  const register = useCallback(async (data: RegisterData) => {
    const res = await apiRegister(data);
    localStorage.setItem("token", res.token);
    setUser({ id: res.user.id, displayName: res.user.displayName, role: res.user.role ?? "user" });
    setConversations(res.conversations);
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
      }
    };

    const onConversationsUpdated = (data: any) => {
      if (data.action === "single_chat_added" && data.singleChat) {
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
    <AuthContext.Provider value={{ user, conversations, setConversations, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
