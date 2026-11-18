import type { ReviewInput } from '../packages/contracts/src/index.js';
import type { RepositoryAdapter } from '../packages/repository/src/index.js';

export const usersPath = 'src/users.ts';
export const routePath = 'src/route.ts';
const baseUsers = `export function findUser(id: string) {
  const user = id === 'known' ? { id } : undefined;
  if (!user) {
    return undefined;
  }
  return user;
}
`;
const thrown = "    throw new Error('User not found');";
const headUsers = baseUsers.replace('    return undefined;', thrown);
const route = `import { findUser as getUser } from './users.js';
export function route(id: string) {
  const user = getUser(id);
  if (!user) return { status: 404 };
  return { status: 200, user };
}
`;
const handledRoute = `import { findUser as getUser } from './users.js';
export function route(id: string) {
  try {
    const user = getUser(id);
    if (!user) return { status: 404 };
    return { status: 200, user };
  } catch {
    return { status: 404 };
  }
}
`;
const unrelated = `import { findUser as getUser } from './other.js';
export function unrelated(id: string) {
  const user = getUser(id);
  if (!user) return { status: 404 };
  return { status: 200, user };
}
`;
const hunk = `@@ -1,7 +1,7 @@
 export function findUser(id: string) {
   const user = id === 'known' ? { id } : undefined;
   if (!user) {
-    return undefined;
+${thrown}
   }
   return user;
 }`;
const handlerHunk = `@@ -1,6 +1,10 @@
 import { findUser as getUser } from './users.js';
 export function route(id: string) {
-  const user = getUser(id);
-  if (!user) return { status: 404 };
-  return { status: 200, user };
+  try {
+    const user = getUser(id);
+    if (!user) return { status: 404 };
+    return { status: 200, user };
+  } catch {
+    return { status: 404 };
+  }
 }`;

export function missingUserFixture(input: ReviewInput, options: {
  fixed?: 'return' | 'handler';
  extra?: Record<string, string>;
  callerUnavailable?: boolean;
  route?: string;
} = {}) {
  const head: Record<string, string> = { [usersPath]: options.fixed === 'return' ? baseUsers : headUsers,
    [routePath]: options.fixed === 'handler' ? handledRoute : options.route ?? route,
    'src/handled.ts': handledRoute, 'src/unrelated.ts': unrelated, 'src/other.ts': baseUsers, ...options.extra };
  const base = { ...head, [usersPath]: baseUsers, [routePath]: route };
  const reads: { sha: string; path: string }[] = [];
  const adapter: RepositoryAdapter & Required<Pick<RepositoryAdapter, 'sourceTreeAt'>> = {
    async revisions() { return input; },
    async changedFiles() {
      if (options.fixed === 'return') return [];
      return [{ path: usersPath, hunk, status: 'modified' }, ...(options.fixed === 'handler' ? [{ path: routePath, hunk: handlerHunk, status: 'modified' }] : [])];
    },
    async sourceTreeAt(sha) { return { complete: true, paths: Object.keys(sha === input.baseSha ? base : head) }; },
    async fileAt(sha, path) {
      reads.push({ sha, path });
      const snapshot = sha === input.baseSha ? base : sha === input.headSha ? head : undefined;
      if (!snapshot || !Object.hasOwn(snapshot, path) || (sha === input.headSha && options.callerUnavailable && path === routePath)) throw new Error('Unavailable fixture file');
      return snapshot[path]!;
    },
    async close() {},
  };
  return { adapter, reads };
}
