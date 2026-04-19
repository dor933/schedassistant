import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import LoginPage from "./pages/LoginPage";
import OnboardingWizard from "./pages/OnboardingWizard";
import ChatPage from "./pages/ChatPage";
import AdminPage from "./pages/AdminPage";
import RoundtablePage from "./pages/RoundtablePage";
import PlatformAdminLoginPage from "./pages/PlatformAdminLoginPage";
import PlatformAdminPage from "./pages/PlatformAdminPage";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  return <>{children}</>;
}

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={user ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route
        path="/onboarding"
        element={user ? <Navigate to="/" replace /> : <OnboardingWizard />}
      />
      <Route
        path="/admin"
        element={
          <ProtectedRoute>
            <AdminPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/roundtable"
        element={
          <ProtectedRoute>
            <RoundtablePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/roundtable/:id"
        element={
          <ProtectedRoute>
            <RoundtablePage />
          </ProtectedRoute>
        }
      />
      {/*
       * Platform-admin routes are intentionally OUTSIDE ProtectedRoute —
       * that gate checks tenant AuthContext (`user`), which platform admins
       * never populate. PlatformAdminPage manages its own token check and
       * redirects to /platform-admin/login when absent.
       */}
      <Route path="/platform-admin/login" element={<PlatformAdminLoginPage />} />
      <Route path="/platform-admin" element={<PlatformAdminPage />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <ChatPage />
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
