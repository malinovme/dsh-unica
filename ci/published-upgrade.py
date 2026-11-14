"""Verify published port upgrades on a disposable Ubuntu or Windows runner."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile
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


def release(tag, root):
    url = f"{SOURCE}/releases/download/{tag}/{ASSET}"
    manifest = json.loads(download(url + ".sha256.json"))
    archive = download(url)
    assert manifest["version"] == tag[1:] and digest(archive) == manifest["sha256"], tag
    path = root / (tag + ".tar.gz")
    path.write_bytes(archive)
    with tarfile.open(path) as tar:
        files = {f.name: digest(tar.extractfile(f).read()) for f in tar if f.isfile()}
    assert len(files) == manifest["fileCount"] and set(files) == set(manifest["contents"])
    print(f"{tag}: {len(files)} published files, SHA-256 {manifest['sha256']}", flush=True)
    return files, manifest


def installed_files(plugin):
    return {p.relative_to(plugin).as_posix(): digest(p.read_bytes())
            for p in plugin.rglob("*") if p.is_file()}


def tagged_file(tag, path):
    # Actions checks out tags, so scripts and fixtures match the selected release.
    return subprocess.check_output(["git", "show", f"{tag}:{path}"], cwd=REPO)


def verify(old, new, root):
    plugin, home, cwd = root / "dsh-unica-plugin", root / "dsh home", root / "workspace"
    cwd.mkdir()
    profile = home / "profiles/web/cordis.patch.yml"
    windows = os.name == "nt"
    wrapper = root / ("install.ps1" if windows else "install.sh")
    wrapper.write_bytes(tagged_file(new, wrapper.name))
    print(f"Checking published upgrade {old} -> {new} on {os.name}", flush=True)
    releases = {tag: release(tag, root) for tag in (old, new)}
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
        args = (["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(wrapper),
                 "-Version", tag, "-Profile", "web", "-Target", "preset", "-DshHome", str(home)]
                if windows else ["sh", str(wrapper)])
        extra = {"UNICA_VERSION": tag}
        if fault:
            extra["UNICA_LAUNCH_SELFTEST_COMMAND"] = json.dumps(["node", str(fault), str(plugin), str(profile), str(witness)])
        output = run(args, extra, expect_success=fault is None)
        assert f"/releases/download/{tag}/" in output and re.search(r"sha256\s*:\s*ok", output)
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
const [plugin, profile, witness] = process.argv.slice(2)
fs.writeFileSync(witness, JSON.stringify({
  version: JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'))).version,
  profile: fs.readFileSync(profile).toString('base64')
}))
console.error('published-upgrade-test: intentional failure')
process.exit(23)
""", encoding="utf-8")
    install(new, fault)
    probe = json.loads(witness.read_bytes())
    candidate = base64.b64decode(probe["profile"])
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

    install(new)
    assert installed_files(plugin) == releases[new][0] and not transaction.exists()
    updated = profile.read_bytes()
    assert updated == candidate and updated.count(needle.encode()) == 1
    for block in (USER_BEFORE, USER_AFTER):
        assert updated.count(block.replace("\n", eol).encode()) == 1
    verify_profile()
    print(f"Upgrade to {new} preserved both user blocks byte-for-byte", flush=True)

    if version(new) >= (0, 15, 0, 6):
        # The two shutdown regressions were introduced in this revision. Relative
        # imports from root/test must resolve to the installed release.
        for relative in ["test/native-bridge.test.mjs", "test/fixtures/workspace-server.mjs"]:
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(tagged_file(new, relative))
        output = run(["node", "--test", "--test-reporter=tap", "--test-name-pattern=closeAll",
                      str(root / "test/native-bridge.test.mjs")])
        for name in ["closeAll during initialize stops the worker and rejects every waiting call",
                     "closeAll prevents dispatch to an already acquired warm worker"]:
            assert re.search(r"^ok \d+ - " + re.escape(name) + r"$", output, re.MULTILINE), name


if __name__ == "__main__":
    old, new = os.environ["FROM_TAG"], os.environ["TO_TAG"]
    if not version(old) < version(new) or version(new) < (0, 15, 0, 5):
        raise SystemExit("choose increasing published tags; rollback requires target v0.15.0.5 or later")
    with tempfile.TemporaryDirectory(prefix="published upgrade ", dir=os.environ.get("RUNNER_TEMP")) as directory:
        verify(old, new, Path(directory).resolve())
