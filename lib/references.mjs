import { createHash } from "node:crypto";

// Only immutable GitHub sources are shared. Arbitrary custom URLs keep the
// original per-job cache because their version cannot be determined reliably.
export async function resolveReferenceVersion(base, signal, fetcher = fetch) {
  const url = new URL(base);
  if (url.origin !== "https://raw.githubusercontent.com" || url.search) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4) return null;
  const [owner, repo, ref, ...directory] = parts;
  let commit = ref;
  if (!/^[a-f0-9]{40}$/i.test(commit)) {
    const api = new URL(`https://api.github.com/repos/${owner}/${repo}/commits`);
    api.searchParams.set("sha", decodeURIComponent(ref));
    api.searchParams.set("path", directory.map(decodeURIComponent).join("/"));
    api.searchParams.set("per_page", "1");
    try {
      const response = await fetcher(api, {
        headers: { Accept: "application/vnd.github+json" },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`GitHub HTTP ${response.status}`);
      }
      const entries = await response.json();
      commit = entries[0]?.sha;
      if (typeof commit !== "string" || !/^[a-f0-9]{40}$/i.test(commit))
        throw new Error("No valid data commit returned");
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error(`Could not check the reference data version: ${error.message}. Resume to retry.`, { cause: error });
    }
  }
  commit = commit.toLowerCase();
  return {
    commit,
    base: `${url.origin}/${owner}/${repo}/${commit}/${directory.join("/")}/`,
  };
}

export function referenceCacheKey(base) {
  // Bump the prefix if the metadata index schema changes.
  return "v1-" + createHash("sha256").update(base).digest("hex");
}
