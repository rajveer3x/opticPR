"""Build deterministic synthetic Git PRs and seal the split. No reviewed code is run."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1] / 'fixtures' / 'evaluation'
source = root / 'cases.json'
data = json.loads(source.read_text())
env = {**os.environ, 'GIT_AUTHOR_NAME': 'OpticPR Evaluation', 'GIT_AUTHOR_EMAIL': 'evaluation@opticpr.invalid',
       'GIT_COMMITTER_NAME': 'OpticPR Evaluation', 'GIT_COMMITTER_EMAIL': 'evaluation@opticpr.invalid',
       'GIT_AUTHOR_DATE': '2026-01-02T00:00:00+00:00', 'GIT_COMMITTER_DATE': '2026-01-02T00:00:00+00:00',
       'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': os.devnull}
inputs = {}
with tempfile.TemporaryDirectory(prefix='opticpr-evaluation-build-') as directory:
    def git(*args):
        return subprocess.check_output(['git', '-C', directory, *args], env=env, text=True).strip()
    git('init', '--initial-branch=main', '--object-format=sha1')
    git('config', 'core.autocrlf', 'false')
    path = Path(directory) / 'src' / 'change.ts'
    path.parent.mkdir()
    path.write_text('// Synthetic evaluation root\n')
    git('add', '.')
    git('-c', 'commit.gpgsign=false', 'commit', '-m', 'Evaluation root')
    root_sha = git('rev-parse', 'HEAD')
    for number, case in enumerate(data['cases'], 1):
        git('checkout', '--quiet', '-B', case['id'], root_sha)
        path.write_text(case['base'])
        git('add', '.')
        git('-c', 'commit.gpgsign=false', 'commit', '-m', case['id'] + ' base')
        base = git('rev-parse', 'HEAD')
        path.write_text(case['head'])
        git('add', '.')
        git('-c', 'commit.gpgsign=false', 'commit', '-m', case['id'] + ' change')
        inputs[case['id']] = {'source': 'fixture', 'repositoryId': 'fixture/evaluation-v1',
            'pullRequestNumber': number, 'baseSha': base, 'headSha': git('rev-parse', 'HEAD')}
    git('bundle', 'create', str(root / 'repository.bundle'), '--all')
manifest = root / 'manifest.json'
manifest.write_text(json.dumps(inputs, indent=2) + '\n')
seal = {'version': 1, 'casesSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'manifestSha256': hashlib.sha256(manifest.read_bytes()).hexdigest(),
        'bundleSha256': hashlib.sha256((root / 'repository.bundle').read_bytes()).hexdigest(),
        'splits': {split: [case['id'] for case in data['cases'] if case['split'] == split] for split in ['tuning', 'evaluation']}}
seal_path = root / 'seal.json'
if seal_path.exists() and json.loads(seal_path.read_text()) != seal:
    raise SystemExit('Dataset differs from its seal. Create a new version rather than resealing held-out cases.')
seal_path.write_text(json.dumps(seal, indent=2) + '\n')
print('Verified sealed 10/20 split and deterministic Git bundle.')
