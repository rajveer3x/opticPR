import { Provider } from "react-redux";
import { RouterProvider } from "react-router-dom";

import { AuthProvider } from "@/contexts/AuthContext";
import { router } from "@/routes";
import { store } from "@/store";

export function App(): JSX.Element {
  return (
    <Provider store={store}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </Provider>
  );
}
