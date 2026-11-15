"""Verify a published installation upgrading to a checkout or another published release."""
import base64
from contextlib import contextmanager
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
from threading import Thread
from urllib.request import urlopen

REPO = Path(__file__).resolve().parents[1]
ASSET = "dsh-plugin-unica.tar.gz"
SOURCE = "https://github.com/malinovme/dsh-unica"
USER_BEFORE = """    - id: project-preferences
      name: user-preferences
      config:
        locale: ru-RU
        paths:
          - 'Проект с пробелом'"""
USER_AFTER = """    # Пользовательские правила
    - id: project-rules
      name: user-rules
      disabled: !!js process.platform === 'win32'
      config:
        note: |
          Keep this line
          # Literal text"""


def version(tag):
    if not re.fullmatch(r"v[0-9]+(?:\.[0-9]+){3}", tag):
        raise ValueError(f"expected a published port tag such as v0.15.0.5, got {tag!r}")
    return tuple(map(int, tag[1:].split(".")))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def download(url):
    with urlopen(url, timeout=90) as response:
        return response.read()


def published_url(tag):
    return f"{SOURCE}/releases/download/{tag}"


@contextmanager
def checkout_release(old, root):
    source = root / "candidate-source"
    shutil.copytree(REPO / "dsh-unica-plugin", source, ignore=shutil.ignore_patterns("node_modules"))
    metadata = source / "package.json"
    package = json.loads(metadata.read_bytes())
    tag = "v" + package["version"]
    # Installer-only PRs usually keep the published version. Give the isolated
    # candidate a distinct identity so the fault witness proves it actually ran.
    baseline = version(old)
    if version(tag) <= baseline:
        revision = baseline[-1] + 1
        package["version"] = ".".join(map(str, (*baseline[:-1], revision)))
        package["unica"]["portRevision"] = str(revision)
        metadata.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        tag = "v" + package["version"]

    assets = root / "assets"
    assets.mkdir()
    subprocess.run(["node", str(source / "package.mjs"), "--out", str(assets / ASSET)], check=True)
    handler = partial(SimpleHTTPRequestHandler, directory=str(assets))
    with ThreadingHTTPServer(("127.0.0.1", 0), handler) as server:
        thread = Thread(target=server.serve_forever)
        thread.start()
        try:
            yield tag, f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            thread.join()


def release(tag, root, base_url):
    url = f"{base_url}/{ASSET}"
    manifest = json.loads(download(url + ".sha256.json"))
    archive = download(url)
    assert manifest["version"] == tag[1:] and digest(archive) == manifest["sha256"], tag
    path = root / (tag + ".tar.gz")
    path.write_bytes(archive)
    with tarfile.open(path) as tar:
        files = {f.name: digest(tar.extractfile(f).read()) for f in tar if f.isfile()}
    assert len(files) == manifest["fileCount"] and set(files) == set(manifest["contents"])
    print(f"{tag}: {len(files)} files, SHA-256 {manifest['sha256']}", flush=True)
    return files, manifest


def installed_files(plugin):
    return {p.relative_to(plugin).as_posix(): digest(p.read_bytes())
            for p in plugin.rglob("*") if p.is_file()}


def tagged_file(tag, path):
    # Actions checks out tags, so scripts and fixtures match the selected release.
    return subprocess.check_output(["git", "show", f"{tag}:{path}"], cwd=REPO)


def verify(old, new, root, candidate_url=None):
    plugin, home, cwd = root / "dsh-unica-plugin", root / "dsh home", root / "workspace"
    cwd.mkdir()
    profile = home / "profiles/web/cordis.patch.yml"
    windows = os.name == "nt"
    wrapper = root / ("install.ps1" if windows else "install.sh")
    staged_profile = version(new) >= (0, 15, 0, 7)
    source = "checkout build" if candidate_url else "published release"
    print(f"Checking published {old} -> {source} {new} on {os.name}", flush=True)
    urls = {old: published_url(old), new: candidate_url or published_url(new)}
    releases = {tag: release(tag, root, url) for tag, url in urls.items()}
    env = {**os.environ, "UNICA_INSTALL_DIR": str(plugin), "UNICA_DSH_HOME": str(home),
           "UNICA_PROFILE": "web", "UNICA_TARGET": "preset", "UNICA_VERIFY": "1",
           "UNICA_ARTIFACT_DELIVERY": "off", "UNICA_REPO": "malinovme/dsh-unica"}
    for key in ("UNICA_BASE_URL", "UNICA_LAUNCH_SELFTEST_COMMAND"):
        env.pop(key, None)

    def run(args, extra=None, expect_success=True):
        proc = subprocess.run(args, env={**env, **(extra or {})}, cwd=cwd,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=240)
        output = proc.stdout.decode("utf-8", errors="replace").replace("\r\n", "\n")
        print(output, flush=True)
        assert (proc.returncode == 0) == expect_success, f"unexpected exit {proc.returncode}: {args}"
        return output

    def install(tag, fault=None):
        if tag == new and (candidate_url or os.environ.get("CHECKOUT_INSTALLER") == "1"):
            wrapper.write_bytes((REPO / wrapper.name).read_bytes())
            print(f"Using checked-out {wrapper.name} with {source} {tag}", flush=True)
        else:
            wrapper.write_bytes(tagged_file(tag, wrapper.name))
        args = (["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(wrapper),
                 "-Version", tag, "-Profile", "web", "-Target", "preset", "-DshHome", str(home)]
                if windows else ["sh", str(wrapper)])
        extra = {"UNICA_VERSION": tag}
        if tag == new and candidate_url:
            if windows:
                args.extend(["-BaseUrl", candidate_url])
            else:
                extra["UNICA_BASE_URL"] = candidate_url
        if fault:
            extra["UNICA_LAUNCH_SELFTEST_COMMAND"] = json.dumps(["node", str(fault), str(plugin), str(profile), str(witness),
                                                                  "staged" if staged_profile else "live"])
        output = run(args, extra, expect_success=fault is None)
        assert f"{urls[tag]}/{ASSET}" in output and re.search(r"sha256\s*:\s*ok", output)
        if fault:
            assert "published-upgrade-test: intentional failure" in output
        else:
            manifest = releases[tag][1]
            assert f"serverInfo unica {manifest['upstreamVersion']}, {manifest['tools']} tools" in output

    def verify_profile():
        run(["node", str(plugin / "tools/verify-install.mjs"), str(home), "web"])

    install(old)
    assert installed_files(plugin) == releases[old][0]
    eol = "\r\n" if windows else "\n"
    needle = "    - id: preset-unica-1c"
    original = profile.read_text(encoding="utf-8")
    assert original.count(needle) == 1
    customized = original.replace(needle, USER_BEFORE + "\n" + needle).rstrip("\n") + "\n" + USER_AFTER + "\n"
    baseline = customized.replace("\n", eol).encode()
    profile.write_bytes(baseline)
    verify_profile()

    fault, witness = root / "intentional-failure.cjs", root / "witness.json"
    fault.write_text("""const fs = require('node:fs')
const path = require('node:path')
const [plugin, profile, witness, mode] = process.argv.slice(2)
let candidate = profile
if (mode === 'staged') {
  const transaction = path.join(path.dirname(plugin), '.' + path.basename(plugin) + '.update')
  const draftDir = process.platform === 'win32'
    ? path.join(path.dirname(profile), fs.readFileSync(path.join(transaction, 'draft-name'), 'utf8'))
    : path.join(transaction, 'draft')
  candidate = path.join(draftDir, 'cordis.patch.yml')
}
fs.writeFileSync(witness, JSON.stringify({
  version: JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'))).version,
  live: fs.readFileSync(profile).toString('base64'),
  candidate: fs.readFileSync(candidate).toString('base64')
}))
console.error('published-upgrade-test: intentional failure')
process.exit(23)
""", encoding="utf-8")
    install(new, fault)
    probe = json.loads(witness.read_bytes())
    candidate = base64.b64decode(probe["candidate"])
    assert base64.b64decode(probe["live"]) == (baseline if staged_profile else candidate)
    assert probe["version"] == new[1:] and candidate != baseline
    assert installed_files(plugin) == releases[old][0] and profile.read_bytes() == baseline
    transaction = root / ("." + plugin.name + ".update")
    assert not transaction.exists()
    verify_profile()
    report = json.loads(run(["node", str(plugin / "host/selftest.js"), "--cwd", str(cwd)], {
        "UNICA_RUNTIME_CACHE_DIR": str(home / "unica/runtimes"),
        "UNICA_PROVIDER_STATE_DIR": str(home / "unica/provider-state"),
    }))
    assert report["ok"] and report["tools"] == releases[old][1]["tools"] and report["workspace"] == "matched"
    print(f"Rollback restored {old}, profile SHA-256 {digest(baseline)} and a working runtime", flush=True)

    def verify_new_files_and_settings():
        assert installed_files(plugin) == releases[new][0]
        updated = profile.read_bytes()
        assert updated == candidate and updated.count(needle.encode()) == 1
        for block in (USER_BEFORE, USER_AFTER):
            assert updated.count(block.replace("\n", eol).encode()) == 1
        verify_profile()
        print(f"Upgrade to {new} preserved both user blocks byte-for-byte", flush=True)

    try:
        install(new)
    except AssertionError:
        # A committed upgrade can still exit nonzero during journal cleanup.
        # Report the state on disk while keeping that installer failure visible.
        if (transaction / "committed").is_file():
            print("Installer failed after commit; checking files and live profile", flush=True)
            verify_new_files_and_settings()
        raise
    verify_new_files_and_settings()
    assert not transaction.exists()

    if version(new) >= (0, 15, 0, 6):
        # The two shutdown regressions were introduced in this revision. Relative
        # imports from root/test must resolve to the installed release.
        for relative in ["test/native-bridge.test.mjs", "test/fixtures/workspace-server.mjs"]:
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes((REPO / relative).read_bytes() if candidate_url else tagged_file(new, relative))
        output = run(["node", "--test", "--test-reporter=tap", "--test-name-pattern=closeAll",
                      str(root / "test/native-bridge.test.mjs")])
        for name in ["closeAll during initialize stops the worker and rejects every waiting call",
                     "closeAll prevents dispatch to an already acquired warm worker"]:
            assert re.search(r"^ok \d+ - " + re.escape(name) + r"$", output, re.MULTILINE), name


if __name__ == "__main__":
    old = os.environ.get("FROM_TAG") or os.environ["LATEST_TAG"]
    new = os.environ.get("TO_TAG")
    version(old)
    with tempfile.TemporaryDirectory(prefix="published upgrade ", dir=os.environ.get("RUNNER_TEMP")) as directory:
        root = Path(directory).resolve()
        if new:
            if not version(old) < version(new) or version(new) < (0, 15, 0, 5):
                raise SystemExit("choose increasing published tags; rollback requires target v0.15.0.5 or later")
            verify(old, new, root)
        else:
            with checkout_release(old, root) as (tag, url):
                verify(old, tag, root, url)
