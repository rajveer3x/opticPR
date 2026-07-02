import { Navigate, createBrowserRouter } from "react-router-dom";

import { AppShell } from "@/layouts/AppShell";
import { ProtectedRoute } from "@/layouts/ProtectedRoute";
import { AuthCallbackPage } from "@/pages/AuthCallbackPage";
import { LoginPage } from "@/pages/LoginPage";
import { PullRequestDetailPage } from "@/pages/PullRequestDetailPage";
import { PullRequestListPage } from "@/pages/PullRequestListPage";

export const router = createBrowserRouter([
  {
    path: "/",
    element: <Navigate to="/pull-requests" replace />,
  },
  {
    path: "/login",
    element: <LoginPage />,
  },
  {
    path: "/auth/callback",
    element: <AuthCallbackPage />,
  },
  {
    element: <ProtectedRoute />,
    children: [
      {
        element: <AppShell />,
        children: [
          {
            path: "/pull-requests",
            element: <PullRequestListPage />,
          },
          {
            path: "/pull-requests/:id",
            element: <PullRequestDetailPage />,
          },
        ],
      },
    ],
  },
  {
    path: "*",
    element: <Navigate to="/pull-requests" replace />,
  },
]);
