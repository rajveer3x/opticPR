import { configureStore, createSlice } from '@reduxjs/toolkit';
import {
  createApi,
  fetchBaseQuery,
  type BaseQueryFn,
  type FetchArgs,
  type FetchBaseQueryError,
} from '@reduxjs/toolkit/query/react';
import { setupListeners } from '@reduxjs/toolkit/query';
import {
  repositoryListSchema,
  pullRequestListSchema,
  runDetailSchema,
  sessionSchema,
  type DashboardSession,
  type RunDetail,
  type RunSummary,
} from '@opticpr/contracts';

export const authGate = createSlice({
  name: 'auth',
  initialState: { expired: false },
  reducers: {
    expire(state) {
      state.expired = true;
    },
  },
});
const base = fetchBaseQuery({
  baseUrl: '/api/',
  credentials: 'same-origin',
  prepareHeaders(headers, { getState }) {
    const session = api.endpoints.session.select()(
      getState() as ReturnType<typeof store.getState>,
    ).data;
    if (session) headers.set('x-csrf-token', session.csrfToken);
    return headers;
  },
});
const authenticatedBase: BaseQueryFn<
  string | FetchArgs,
  unknown,
  FetchBaseQueryError
> = async (args, context, options) => {
  const result = await base(args, context, options);
  if (
    result.error?.status === 401 &&
    (typeof args === 'string' ? args : args.url) !== 'session'
  ) {
    // Revocation must also remove previously cached private reports from the screen.
    context.dispatch(authGate.actions.expire());
    context.dispatch(api.util.resetApiState());
  }
  return result;
};
export const api = createApi({
  reducerPath: 'dashboard',
  baseQuery: authenticatedBase,
  tagTypes: ['Reviews', 'Session'],
  endpoints: (build) => ({
    session: build.query<DashboardSession, void>({
      query: () => 'session',
      transformResponse: (value) => sessionSchema.parse(value),
      providesTags: ['Session'],
    }),
    repositories: build.query<
      ReturnType<typeof repositoryListSchema.parse>,
      void
    >({
      query: () => 'repos',
      transformResponse: (value) => repositoryListSchema.parse(value),
    }),
    pullRequests: build.query<
      ReturnType<typeof pullRequestListSchema.parse>,
      { id: string; page: number }
    >({
      query: ({ id, page }) =>
        `repos/${encodeURIComponent(id)}/prs?page=${page}`,
      transformResponse: (value) => pullRequestListSchema.parse(value),
      providesTags: ['Reviews'],
    }),
    run: build.query<RunDetail, string>({
      query: (id) => `runs/${encodeURIComponent(id)}`,
      transformResponse: (value) => runDetailSchema.parse(value),
      providesTags: ['Reviews'],
    }),
    retry: build.mutation<
      { runId: string },
      { runId: string; id: string; reason: string }
    >({
      query: ({ runId, ...body }) => ({
        url: `runs/${runId}/retry`,
        method: 'POST',
        body,
      }),
      invalidatesTags: ['Reviews'],
    }),
    decide: build.mutation<
      unknown,
      {
        findingId: string;
        runId: string;
        id: string;
        reason: string;
        action: 'dismiss' | 'reopen';
      }
    >({
      query: ({ findingId, ...body }) => ({
        url: `findings/${findingId}/decisions`,
        method: 'POST',
        body,
      }),
      invalidatesTags: ['Reviews'],
    }),
    logout: build.mutation<void, void>({
      query: () => ({ url: 'logout', method: 'POST' }),
    }),
  }),
});
export const store = configureStore({
  reducer: { [api.reducerPath]: api.reducer, auth: authGate.reducer },
  middleware: (getDefault) => getDefault().concat(api.middleware),
});
setupListeners(store.dispatch);
export const isActive = (run?: Pick<RunSummary, 'state'> | null) =>
  !!run && ['queued', 'running'].includes(run.state);
export const runIsActive = (run?: RunDetail) =>
  !!run &&
  (isActive(run) ||
    (run.pullRequest?.eligible && isActive(run.pullRequest.desiredRun)));
export function errorMessage(error: unknown) {
  if (
    error &&
    typeof error === 'object' &&
    'data' in error &&
    error.data &&
    typeof error.data === 'object' &&
    'error' in error.data &&
    typeof error.data.error === 'string'
  )
    return error.data.error;
  return 'We couldn’t load this view. Check your connection and try again.';
}
export function useRun(id: string) {
  // Separate selection avoids retaining a polling timer after a terminal response.
  const cached = api.endpoints.run.useQueryState(id);
  return api.useRunQuery(id, {
    pollingInterval: cached.isError ? 0 : runIsActive(cached.data) ? 4000 : 0,
    skipPollingIfUnfocused: true,
    refetchOnMountOrArgChange: true,
    refetchOnFocus: true,
  });
}
export function usePullRequests(id: string, page: number) {
  const args = { id, page };
  const cached = api.endpoints.pullRequests.useQueryState(args);
  return api.usePullRequestsQuery(args, {
    pollingInterval: !cached.isError && cached.data?.hasActive ? 4000 : 0,
    skipPollingIfUnfocused: true,
    refetchOnMountOrArgChange: true,
    refetchOnFocus: true,
  });
}
