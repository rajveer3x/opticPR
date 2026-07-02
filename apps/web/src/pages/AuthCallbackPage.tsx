import { LoaderCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";

import { useAuth } from "@/contexts/AuthContext";
import { useExchangeGitHubCodeMutation } from "@/store/api";

export function AuthCallbackPage(): JSX.Element {
  const { isAuthenticated, login } = useAuth();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const started = useRef(false);
  const [exchangeCode, { isError }] = useExchangeGitHubCodeMutation();
  const code = searchParams.get("code");
  const token = searchParams.get("token");

  useEffect(() => {
    if (started.current || isAuthenticated) return;

    started.current = true;

    if (token !== null) {
      localStorage.setItem("opticpr_token", token);
      window.location.replace("/pull-requests");
      return;
    }

    if (code !== null) {
      void exchangeCode(code)
        .unwrap()
        .then((response) => {
          login(response);
          navigate("/pull-requests", { replace: true });
        });
    }
  }, [code, exchangeCode, isAuthenticated, login, navigate, token]);

  if (isAuthenticated) return <Navigate replace to="/pull-requests" />;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#09090b] text-zinc-100">
      {isError || (code === null && token === null) ? (
        <>
          <div className="text-sm font-medium">GitHub authentication failed</div>
          <a className="mt-3 text-xs text-violet-400" href="/login">
            Return to sign in
          </a>
        </>
      ) : (
        <>
          <LoaderCircle className="size-5 animate-spin text-violet-400" />
          <div className="mt-4 text-sm text-zinc-500">Connecting your GitHub workspace</div>
        </>
      )}
    </div>
  );
}
