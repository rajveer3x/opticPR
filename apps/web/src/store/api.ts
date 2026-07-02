import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

import type { AuthResponse, PullRequestDetail, PullRequestListResponse, User } from "@/types/api";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000/api/v1";

export const opticApi = createApi({
  reducerPath: "opticApi",
  baseQuery: fetchBaseQuery({
    baseUrl: apiBaseUrl,
    prepareHeaders: (headers) => {
      const token = localStorage.getItem("opticpr_token");

      if (token !== null) {
        headers.set("authorization", `Bearer ${token}`);
      }

      return headers;
    },
  }),
  tagTypes: ["PullRequest", "User"],
  endpoints: (builder) => ({
    exchangeGitHubCode: builder.mutation<AuthResponse, string>({
      query: (code) => ({
        url: "/auth/github/callback",
        method: "POST",
        body: { code },
      }),
    }),
    getCurrentUser: builder.query<User, void>({
      query: () => "/auth/me",
      providesTags: ["User"],
    }),
    getPullRequests: builder.query<PullRequestListResponse, { search?: string; status?: string }>({
      query: (params) => ({ url: "/pull-requests", params }),
      providesTags: (result) =>
        result === undefined
          ? ["PullRequest"]
          : [
              ...result.items.map(({ id }) => ({ type: "PullRequest" as const, id })),
              "PullRequest",
            ],
    }),
    getPullRequest: builder.query<PullRequestDetail, string>({
      query: (id) => `/pull-requests/${id}`,
      providesTags: (_result, _error, id) => [{ type: "PullRequest", id }],
    }),
  }),
});

export const {
  useExchangeGitHubCodeMutation,
  useGetCurrentUserQuery,
  useGetPullRequestQuery,
  useGetPullRequestsQuery,
} = opticApi;
