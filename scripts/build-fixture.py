"""Rebuild the credential-free Git bundle and history scenarios deterministically."""
from pathlib import Path
import json
import os
import subprocess
import tempfile

target = Path(__file__).resolve().parents[1] / "fixtures" / "pagination"
base = """export function paginate<T>(items: T[], page: number, pageSize: number): T[] {
  const start = (page - 1) * pageSize;
  const end = start + pageSize;
  return items.slice(start, end);
}
"""
head = base.replace("start + pageSize;", "start + pageSize - 1;")
env = {**os.environ, "GIT_AUTHOR_NAME": "OpticPR Fixture", "GIT_AUTHOR_EMAIL": "fixture@opticpr.invalid",
       "GIT_COMMITTER_NAME": "OpticPR Fixture", "GIT_COMMITTER_EMAIL": "fixture@opticpr.invalid",
       "GIT_AUTHOR_DATE": "2026-01-01T00:00:00+00:00", "GIT_COMMITTER_DATE": "2026-01-01T00:00:00+00:00",
       "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull}
with tempfile.TemporaryDirectory(prefix="opticpr-fixture-build-") as directory:
    def git(*args):
        return subprocess.check_output(["git", "-C", directory, *args], env=env, text=True).strip()
    git("init", "--initial-branch=main", "--object-format=sha1")
    git("config", "core.autocrlf", "false")
    path = Path(directory) / "src" / "paginate.ts"
    path.parent.mkdir()
    path.write_text(base)
    git("add", ".")
    git("-c", "commit.gpgsign=false", "commit", "-m", "Correct exclusive pagination boundary")
    base_sha = git("rev-parse", "HEAD")
    path.write_text(head)
    git("add", ".")
    git("-c", "commit.gpgsign=false", "commit", "-m", "Introduce final-item regression")
    head_sha = git("rev-parse", "HEAD")
    scenarios = {"original": head_sha}
    for name, contents, renamed in [
        ("moved", "// Pagination helper\n\n" + head, False),
        ("renamed", "// Pagination helper\n\n" + head, True),
        ("fixed", base, False),
        ("ambiguous", head.replace("  const end = start + pageSize - 1;\n  return items.slice(start, end);", ("  {\n    const end = start + pageSize - 1;\n    return items.slice(start, end);\n  }\n" * 2).rstrip()), False),
    ]:
        git("checkout", "--quiet", "-B", name, head_sha)
        destination = path.with_name("pages.ts") if renamed else path
        if renamed:
            path.unlink()
        destination.write_text(contents)
        git("add", "-A")
        git("-c", "commit.gpgsign=false", "commit", "-m", "History scenario: " + name)
        scenarios[name] = git("rev-parse", "HEAD")
    git("checkout", "--quiet", "main")
    git("bundle", "create", str(target / "repository.bundle"), "--all")
    (target / "manifest.json").write_text(json.dumps({
        "source": "fixture", "repositoryId": "fixture/pagination", "pullRequestNumber": 1,
        "baseSha": base_sha, "headSha": head_sha,
    }, indent=2) + "\n")
    (target / "history.json").write_text(json.dumps({"baseSha": base_sha, "scenarios": scenarios}, indent=2) + "\n")
