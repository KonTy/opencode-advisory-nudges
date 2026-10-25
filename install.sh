#!/usr/bin/env bash
set -euo pipefail
command -v python3 >/dev/null || { printf '%s\n' 'Error: install Python 3, then retry.' >&2; exit 1; }
exec python3 - "$@" <<'PYTHON'
import argparse
import fcntl
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

APP = "KonTy/openchamber"
PLUGIN = "KonTy/opencode-advisory-nudges"
FILES = {"core.js", "index.js", "rules.js", "rules.example.json", "package.json", "README.md", "DOCUMENTATION.md", "LICENSE"}
API = "https://api.github.com/repos/"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def command(args, codes=(0,)):
    result = subprocess.run([str(x) for x in args], text=True, capture_output=True,
                            env={**os.environ, "LC_ALL": "C"})
    require(result.returncode in codes,
            f"{Path(args[0]).name} failed ({result.returncode}): {result.stderr.strip()}")
    return result


def tool(name):
    value = shutil.which(name)
    require(value is not None, f"Required command not found: {name}")
    return value


def system_tool(name):
    path = Path(tool(name)).resolve(strict=True)
    require(path.is_file(), f"Expected system executable: {name}")
    for entry in [path, *path.parents]:
        info = entry.stat()
        require(info.st_uid == 0 and not info.st_mode & 0o022,
                f"Privileged tool must be in a root-owned, non-writable system path: {path}")
    return str(path)


def download(url, destination, allow_missing=False, max_size=8_000_000):
    require(url.startswith(("https://api.github.com/", "https://github.com/",
                            "https://raw.githubusercontent.com/")), "Unexpected download origin")
    result = command([tool("curl"), "--silent", "--show-error", "--location",
                      "--proto", "=https", "--proto-redir", "=https", "--fail",
                      "--connect-timeout", "15", "--max-time", "600",
                      "--max-filesize", str(max_size), "--output", destination,
                      "--write-out", "%{http_code}", url], codes=(0, 22))
    if allow_missing and result.returncode == 22 and result.stdout == "404":
        return False
    require(result.returncode == 0, f"Download failed: HTTP {result.stdout}: {url}")
    require(destination.is_file() and destination.stat().st_size > 0, f"Empty download: {url}")
    return True


def parse_json(raw):
    def unique(pairs):
        obj = {}
        for key, value in pairs:
            require(key not in obj, f"Duplicate JSON key: {key}")
            obj[key] = value
        return obj
    return json.loads(raw, object_pairs_hook=unique,
                      parse_constant=lambda value: require(False, f"Invalid JSON constant: {value}"))


def api(path, scratch, optional=False):
    target = scratch / "metadata.json"
    if not download(API + path, target, allow_missing=optional):
        return None
    require(target.stat().st_size <= 8_000_000, "GitHub metadata is unexpectedly large")
    return parse_json(target.read_bytes())


def stable(release):
    require(isinstance(release, dict) and not release.get("draft") and not release.get("prerelease"),
            "Expected a stable published GitHub release")
    require(re.fullmatch(r"v\d+\.\d+\.\d+", release.get("tag_name", "")),
            "Unsupported release version; expected vMAJOR.MINOR.PATCH")
    return release["tag_name"][1:]


def asset_url(asset, repo, tag):
    name = asset["name"]
    require(re.fullmatch(r"[A-Za-z0-9_.+-]+", name), "Unsafe release asset name")
    expected = f"https://github.com/{repo}/releases/download/{tag}/{name}"
    require(asset.get("browser_download_url") == expected, "Unexpected release asset URL")
    return expected


def verify_digest(asset, data):
    digest = asset.get("digest", "")
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", digest or ""), "Missing published SHA256 asset digest")
    require(hashlib.sha256(data).hexdigest() == digest[7:], "Release asset checksum mismatch")


def file_digest(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def distro(os_release, machine):
    values = {}
    for line in os_release.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            values[key] = value.strip().strip('"').strip("'")
    ids = {values.get("ID", ""), *values.get("ID_LIKE", "").split()}
    families = [name for name, known in (
        ("arch", {"arch", "manjaro", "endeavouros"}),
        ("deb", {"debian", "ubuntu", "linuxmint", "pop"}),
        ("rpm", {"fedora", "rhel", "centos", "rocky", "almalinux", "nobara", "opensuse", "suse"}),
    ) if ids & known]
    require(len(families) == 1, "Unsupported or ambiguous distro family in /etc/os-release")
    arch = {"x86_64": "x86_64", "aarch64": "aarch64", "arm64": "aarch64"}.get(machine)
    require(arch is not None, f"Unsupported CPU architecture: {machine}")
    require(not (families[0] == "arch" and arch != "x86_64"), "Arch packages support x86_64 only")
    return families[0], arch


def select_asset(release, family, arch):
    version = stable(release)
    if family == "arch":
        pattern = rf"openchamber-desktop-{re.escape(version)}-\d+-x86_64\.pkg\.tar\.zst"
    else:
        cpu = {"x86_64": "amd64", "aarch64": "arm64"}[arch] if family == "deb" else arch
        pattern = rf"OpenChamber-{re.escape(version)}-linux-{cpu}\.{family}"
    matches = [a for a in release["assets"] if re.fullmatch(pattern, a["name"])]
    require(len(matches) == 1, "Missing or ambiguous exact distro/CPU OpenChamber package")
    return matches[0]


def desktop_package(release, family, arch, scratch):
    asset = select_asset(release, family, arch)
    sums = [a for a in release["assets"] if a["name"] == "SHA256SUMS"]
    require(len(sums) == 1, "Missing or ambiguous SHA256SUMS release asset")
    checksums = scratch / "SHA256SUMS"
    download(asset_url(sums[0], APP, release["tag_name"]), checksums)
    verify_digest(sums[0], checksums.read_bytes())
    matches = []
    for line in checksums.read_text().splitlines():
        match = re.fullmatch(r"([0-9a-f]{64}) [ *](.+)", line)
        if match and match[2] == asset["name"]:
            matches.append(match[1])
    require(len(matches) == 1, "Missing or ambiguous package checksum in SHA256SUMS")
    package = scratch / asset["name"]
    download(asset_url(asset, APP, release["tag_name"]), package, max_size=2_147_483_648)
    digest = file_digest(package)
    require(asset.get("digest") == "sha256:" + digest, "Missing or mismatched published package digest")
    require(digest == matches[0], "Package disagrees with SHA256SUMS")
    return package


def plugin_files(scratch):
    release = api(PLUGIN + "/releases/latest", scratch, optional=True)
    assets = [] if release is None else [a for a in release["assets"] if a["name"].endswith(".tgz")]
    require(len(assets) <= 1, "Ambiguous plugin release tarballs")
    if assets:
        version = stable(release)
        archive = scratch / "plugin.tgz"
        download(asset_url(assets[0], PLUGIN, release["tag_name"]), archive, max_size=2_000_000)
        raw = archive.read_bytes()
        verify_digest(assets[0], raw)
        require(len(raw) <= 2_000_000, "Plugin tarball is unexpectedly large")
        with gzip.GzipFile(fileobj=io.BytesIO(raw)) as compressed:
            expanded = compressed.read(6_000_001)
        require(len(expanded) <= 6_000_000, "Plugin archive expands beyond allowed size")
        with tarfile.open(fileobj=io.BytesIO(expanded), mode="r:") as tar:
            members = tar.getmembers()
            require(len(members) == len(FILES) and
                    {m.name for m in members} == {"package/" + n for n in FILES} and
                    all(m.isfile() and 0 < m.size <= 1_000_000 for m in members),
                    "Unsafe plugin archive: expected eight regular files only (no links or traversal)")
            files = {m.name[8:]: tar.extractfile(m).read() for m in members}
        revision = "release-" + hashlib.sha256(raw).hexdigest()
        label = release["tag_name"]
    else:
        commit = api(PLUGIN + "/commits/main", scratch)["sha"]
        require(re.fullmatch(r"[0-9a-f]{40}", commit), "Invalid immutable plugin commit")
        tree = api(PLUGIN + "/git/trees/" + commit, scratch)
        require(not tree.get("truncated"), "Truncated plugin source tree")
        entries = {e["path"]: e for e in tree["tree"] if e["path"] in FILES}
        require(set(entries) == FILES, "Missing plugin runtime/doc/license files")
        files = {}
        for name, entry in entries.items():
            require(entry["type"] == "blob" and entry["mode"] == "100644" and
                    0 < entry["size"] <= 1_000_000, f"Unsafe source entry: {name}")
            dest = scratch / name
            download(f"https://raw.githubusercontent.com/{PLUGIN}/{commit}/{name}", dest, max_size=1_000_000)
            raw = dest.read_bytes()
            blob = hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()
            require(blob == entry["sha"], f"Plugin Git blob mismatch: {name}")
            files[name] = raw
        revision, label, version = "commit-" + commit, commit, None
    manifest = parse_json(files["package.json"])
    require(manifest.get("name") == "opencode-advisory-nudges" and
            manifest.get("type") == "module" and manifest.get("exports") == {".": "./index.js"} and
            manifest.get("license") == "MIT", "Unexpected plugin package contract")
    require(version is None or manifest.get("version") == version, "Plugin release/version mismatch")
    require(not any(manifest.get(k) for k in ("dependencies", "optionalDependencies", "peerDependencies")),
            "Plugin must use host-supplied Effect, not installed dependencies")
    return files, revision, label


def safe_path(path, home, file=False):
    require(path.is_absolute() and path == Path(os.path.abspath(path)) and path.is_relative_to(home),
            f"Path must be normalized, absolute and below HOME: {path}")
    for part in [*reversed(path.parents), path]:
        if part.exists() or part.is_symlink():
            info = part.lstat()
            require(not stat.S_ISLNK(info.st_mode), f"Symlink refused: {part}")
            require(info.st_uid in (0, os.getuid()), f"Foreign-owned path refused: {part}")
            require(not info.st_mode & 0o022 or
                    (info.st_uid == 0 and stat.S_ISDIR(info.st_mode) and info.st_mode & stat.S_ISVTX),
                    f"Writable-by-others path refused: {part}")
            if part == path and file:
                require(stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1,
                        f"Config must be a user-owned regular file with one link: {part}")
            else:
                require(stat.S_ISDIR(info.st_mode), f"Expected directory: {part}")


def config_snapshot(config, home):
    safe_path(config, home, file=True)
    require(config.name == "opencode.json", "Select an opencode.json file, not app settings or JSONC")
    require(not config.with_suffix(".jsonc").exists() and not config.with_suffix(".jsonc").is_symlink(),
            "Sibling opencode.jsonc exists; resolve layered JSONC manually before installing")
    raw = config.read_bytes() if config.exists() else None
    require(raw is None or len(raw) <= 4_000_000, "Config is unexpectedly large")
    obj = {} if raw is None else parse_json(raw)
    require(isinstance(obj, dict), "Config must be a strict JSON object; JSONC is not rewritten")
    for key in ("plugins", "plugin"):
        require(key not in obj or isinstance(obj[key], list), f"{key} must be an array")
    return raw, obj


def merge_config(obj, target, versions):
    obj = parse_json(json.dumps(obj))
    found = []
    for key in ("plugins", "plugin"):
        for i, entry in enumerate(obj.get(key, [])):
            spec = entry if isinstance(entry, str) else (
                entry.get("package") if isinstance(entry, dict) else
                entry[0] if isinstance(entry, list) and entry else None)
            if not isinstance(spec, str):
                continue
            managed = str(versions) + "/"
            if spec.startswith(managed):
                require(key == "plugins" and isinstance(entry, dict),
                        "Legacy managed registration requires manual migration")
                require(re.fullmatch(r"(commit-[0-9a-f]{40}|release-[0-9a-f]{64})",
                                     spec[len(managed):]), "Malformed managed plugin path")
                found.append(i)
            elif "advisory-nudges" in spec:
                raise ValueError("Unmanaged advisory-nudges registration exists; reconcile it manually")
    require(len(found) <= 1, "Multiple managed plugin registrations; reconcile manually")
    plugins = obj.setdefault("plugins", [])
    if found:
        plugins[found[0]]["package"] = str(target)
    else:
        plugins.append({"package": str(target), "options": {
            "timer": {"enabled": False}, "observer": {"enabled": False}, "repetition": {"enabled": False},
            "rules": {"enabled": False}}})
    return obj


def quiet():
    for process in Path("/proc").iterdir():
        if not process.name.isdecimal():
            continue
        try:
            if process.stat().st_uid != os.getuid() or int(process.name) == os.getpid():
                continue
            args = (process / "cmdline").read_bytes().split(b"\0")
            names = [Path(os.fsdecode(a)).name.lower() for a in args[:2] if a]
            require(not any(n in ("openchamber", "openchamber-desktop", "opencode") or
                            n.startswith(("openchamber-", "opencode-")) for n in names),
                    "Quit OpenChamber and OpenCode first (including background/tray hosts); no process is stopped automatically")
        except (FileNotFoundError, ProcessLookupError):
            continue


def manager(family, os_release=""):
    if family == "arch":
        return {name: system_tool(name) for name in ("pacman", "vercmp")}
    if family == "deb":
        return {name: system_tool(name) for name in ("apt-get", "dpkg-deb", "dpkg-query", "dpkg")}
    suse = re.search(r"(?im)^(ID|ID_LIKE)=.*(?:suse|opensuse)", os_release) is not None
    flavor = "zypper" if suse else "dnf"
    return {"rpm": system_tool("rpm"), "install": system_tool(flavor), "flavor": flavor}


def package_plan(family, arch, package, tools, version):
    if family == "arch":
        metadata = command([tools["pacman"], "-Qip", package]).stdout
        values = {}
        for line in metadata.splitlines():
            key, separator, value = line.partition(":")
            if separator and key.strip() in ("Name", "Version", "Architecture"):
                require(key.strip() not in values, "Ambiguous Arch package metadata")
                values[key.strip()] = value.strip()
        fields = [values.get(key) for key in ("Name", "Version", "Architecture")]
        require(all(fields) and fields[0] == "openchamber-desktop" and fields[2] == arch,
                "Unexpected Arch package identity/architecture")
        installed = command([tools["pacman"], "-Q", fields[0]], codes=(0, 1))
        require(installed.returncode == 0 or "was not found" in installed.stderr,
                "pacman could not query the installed package")
        require(installed.returncode != 0 or
                (len(installed.stdout.strip().split()) == 2 and installed.stdout.split()[0] == fields[0]),
                "Unexpected pacman installed-package response")
        current = installed.stdout.strip().split()[-1] if installed.returncode == 0 else None
        compare = (int(command([tools["vercmp"], current, fields[1]]).stdout) if current else -1)
        args = [tools["pacman"], "-U", "--needed", "--noconfirm", package]
    elif family == "deb":
        fields = [command([tools["dpkg-deb"], "--field", package, key]).stdout.strip()
                  for key in ("Package", "Version", "Architecture")]
        require(fields[0] == "openchamber" and fields[2] == {"x86_64": "amd64", "aarch64": "arm64"}[arch],
                "Unexpected DEB package identity/architecture")
        installed = command([tools["dpkg-query"], "-W", "-f=${Status}\n${Version}", fields[0]], codes=(0, 1))
        require(installed.returncode == 0 or "no packages found matching" in installed.stderr,
                "dpkg-query could not query the installed package")
        lines = installed.stdout.strip().splitlines()
        require(installed.returncode != 0 or len(lines) == 2, "Unexpected dpkg-query response")
        require(not lines or lines[0] in ("install ok installed", "deinstall ok config-files"),
                "Package is partially installed/held; resolve with your package manager first")
        current = lines[1] if installed.returncode == 0 and len(lines) == 2 and lines[0] == "install ok installed" else None
        compare = (0 if command([tools["dpkg"], "--compare-versions", current, "ge", fields[1]], codes=(0, 1)).returncode == 0 else -1) if current else -1
        args = [tools["apt-get"], "install", "--yes", "--no-remove", package]
    else:
        query = "%{NAME}\n%{EPOCHNUM}:%{VERSION}-%{RELEASE}\n%{ARCH}\n"
        fields = command([tools["rpm"], "-qp", "--qf", query, package]).stdout.strip().splitlines()
        require(len(fields) == 3 and fields[0] == "openchamber" and fields[2] == arch,
                "Unexpected RPM package identity/architecture")
        installed = command([tools["rpm"], "-q", "--qf", query, fields[0]], codes=(0, 1))
        require(installed.returncode == 0 or "is not installed" in installed.stdout,
                "rpm could not query the installed package")
        require(installed.returncode != 0 or len(installed.stdout.strip().splitlines()) == 3,
                "Unexpected rpm installed-package response")
        current = installed.stdout.strip().splitlines()[1] if installed.returncode == 0 else None
        require(all(re.fullmatch(r"[0-9A-Za-z.+:~_^%-]+", v) for v in (fields[1], current or "0")),
                "Unsafe RPM version")
        compare = int(command([tools["rpm"], "--eval",
                               '%{lua:print(rpm.vercmp("' + current + '", "' + fields[1] + '"))}']).stdout) if current else -1
        args = ([tools["install"], "install", "--assumeyes", "--setopt=install_weak_deps=False",
                 "--setopt=localpkg_gpgcheck=False", package]
                if tools["flavor"] == "dnf" else
                [tools["install"], "--non-interactive", "--no-refresh", "install", "--allow-unsigned-rpm", package])
    require(re.search(r"(^|:)" + re.escape(version) + r"(-|$)", fields[1]),
            "Package version disagrees with release")
    return compare < 0, args


def commit_config(config, home, before, merged):
    current, obj = config_snapshot(config, home)
    require(current == before, "Config changed during installation; refusing to overwrite it")
    if obj == merged:
        return
    config.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    safe_path(config.parent, home)
    backup = None
    if before is not None:
        backup = config.with_name(config.name + ".backup-" + str(time.time_ns()))
        with os.fdopen(os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as stream:
            stream.write(before)
            stream.flush()
            os.fsync(stream.fileno())
        require(backup.read_bytes() == before, "Config backup verification failed")
    fd, temp = tempfile.mkstemp(prefix=".opencode-install-", dir=config.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write((json.dumps(merged, indent=2, ensure_ascii=False) + "\n").encode())
            stream.flush()
            os.fsync(stream.fileno())
        require(config_snapshot(config, home)[0] == before, "Config changed before atomic write")
        os.replace(temp, config)
        directory = os.open(config.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)
    if backup:
        print("Verified settings backup:", backup)


def main(argv=None):
    parser = argparse.ArgumentParser(description=(
        "Install/update latest stable KonTy OpenChamber and its default-off advisory plugin. "
        "Requires Bash, Python 3.9+, curl, pkexec and native distro package tools. Never run as root."))
    parser.add_argument("--config", type=Path, help=(
        "Required absolute user-owned opencode.json used by your LOCAL desktop host; "
        "select it explicitly because login-shell/remote profiles can differ."))
    parser.add_argument("--dry-run", action="store_true", help=(
        "Download, verify and inspect both packages/config; print plan without installing or writing user data."))
    args = parser.parse_args(argv)
    require(sys.version_info >= (3, 9), "Python 3.9 or newer is required")
    require(sys.platform == "linux" and os.geteuid() != 0 and os.getuid() == os.geteuid(),
            "Run on Linux as the ordinary desktop user, never root/sudo")
    home = Path(os.environ.get("HOME", ""))
    require(home.is_absolute() and home.stat().st_uid == os.getuid(), "HOME must belong to the current user")
    require(args.config is not None, "Pass --config /absolute/path/to/your/local/host/opencode.json (see README)")
    require(not os.environ.get("OPENCODE_CONFIG_CONTENT"), "Inline OPENCODE_CONFIG_CONTENT must be reconciled manually")
    config = args.config
    before, obj = config_snapshot(config, home)
    data = Path(os.environ.get("XDG_DATA_HOME") or str(home / ".local/share"))
    versions = data / "openchamber/advisory-nudges"
    safe_path(versions, home)
    os_release = Path("/etc/os-release").read_text()
    family, arch = distro(os_release, platform.machine())
    tools, polkit = manager(family, os_release), system_tool("pkexec")
    if not args.dry_run:
        quiet()
    with tempfile.TemporaryDirectory(prefix="openchamber-install-") as temp:
        scratch = Path(temp)
        release = api(APP + "/releases/latest", scratch)
        version = stable(release)
        descriptor = scratch / "desktop-package.json"
        download(f"https://raw.githubusercontent.com/{APP}/{release['tag_name']}/packages/electron/package.json", descriptor)
        require(parse_json(descriptor.read_bytes()).get("opencodeCli", {}).get("version") == "2.1.4",
                "Latest desktop no longer bundles supported OpenCode 2.1.4; installer needs compatibility review")
        package = desktop_package(release, family, arch, scratch)
        files, revision, label = plugin_files(scratch)
        target = versions / revision
        safe_path(target, home)
        if target.exists():
            require({p.name for p in target.iterdir()} == FILES, "Existing snapshot has unexpected files")
            for name, raw in files.items():
                safe_path(target / name, home, file=True)
                require((target / name).read_bytes() == raw, "Existing immutable plugin snapshot was modified")
        merged = merge_config(obj, target, versions)
        install, install_args = package_plan(family, arch, package, tools, version)
        print(f"OpenChamber latest stable: {release['tag_name']} ({family}/{arch}); " +
              ("install/update" if install else "installed version is equal/newer; preserve it"))
        print(f"Plugin revision: {label}\nSelected LOCAL host config: {config}\nImmutable plugin path: {target}")
        if args.dry_run:
            print("Dry run verified. No package installation, settings writes, backup or plugin promotion performed.")
            return
        versions.mkdir(parents=True, exist_ok=True, mode=0o700)
        safe_path(versions, home)
        lock = versions / ".install.lock"
        require(not lock.is_symlink(), "Installer lock symlink refused")
        fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            require(info.st_uid == os.getuid() and info.st_nlink == 1 and stat.S_ISREG(info.st_mode)
                    and not info.st_mode & 0o077,
                    "Unsafe installer lock")
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            quiet()
            require(config_snapshot(config, home)[0] == before, "Config changed; retry at a quiet boundary")
            if install:
                print("Requesting Polkit approval for ONLY the native package manager; do not start the host yet.")
                result = subprocess.run([polkit, "--disable-internal-agent", *map(str, install_args)])
                require(result.returncode == 0, "Package manager/Polkit failed or was cancelled; plugin config not changed")
            quiet()
            require(config_snapshot(config, home)[0] == before,
                    "Config changed after package installation; app may be updated, plugin not registered")
            if not target.exists():
                stage = Path(tempfile.mkdtemp(prefix=".staging-", dir=versions))
                try:
                    for name, raw in files.items():
                        (stage / name).write_bytes(raw)
                        os.chmod(stage / name, 0o444)
                    os.chmod(stage, 0o555)
                    os.rename(stage, target)
                finally:
                    if stage.exists():
                        os.chmod(stage, 0o700)
                        shutil.rmtree(stage)
            commit_config(config, home, before, merged)
        finally:
            os.close(fd)
    print("Installed/updated; no host started or restarted. New registration has ALL modes OFF.")
    print("Existing managed options were preserved. Opt into timer-only with exact scopes/private audit per README.")
    print("Native activation/loop-recovery efficacy is NOT established by this installer.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, EOFError, KeyError, TypeError, tarfile.TarError) as error:
        print(f"Error: {error}", file=sys.stderr)
        sys.exit(1)
PYTHON
