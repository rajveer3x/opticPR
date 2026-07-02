import { configureStore } from "@reduxjs/toolkit";

import { opticApi } from "@/store/api";
import { authReducer } from "@/store/authSlice";

export const store = configureStore({
  reducer: {
    auth: authReducer,
    [opticApi.reducerPath]: opticApi.reducer,
  },
  middleware: (getDefaultMiddleware) => getDefaultMiddleware().concat(opticApi.middleware),
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
