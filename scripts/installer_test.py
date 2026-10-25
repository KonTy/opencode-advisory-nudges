import copy
from contextlib import redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
SOURCE = (ROOT / "install.sh").read_text().split("<<'PYTHON'\n", 1)[1].rsplit("\nPYTHON", 1)[0]
M = types.ModuleType("installer")
exec(compile(SOURCE, "install.sh (embedded Python)", "exec"), M.__dict__)


def result(stdout="", code=0, stderr=""):
    return subprocess.CompletedProcess([], code, stdout, stderr)


def asset(name, data, repo=M.APP, tag="v2.5.2"):
    return {"name": name, "browser_download_url": f"https://github.com/{repo}/releases/download/{tag}/{name}",
            "digest": "sha256:" + hashlib.sha256(data).hexdigest()}


def release():
    return {"tag_name": "v2.5.2", "draft": False, "prerelease": False, "assets": [
        asset(n, b"package") for n in (
            "openchamber-desktop-2.5.2-1-x86_64.pkg.tar.zst",
            "OpenChamber-2.5.2-linux-amd64.deb", "OpenChamber-2.5.2-linux-arm64.deb",
            "OpenChamber-2.5.2-linux-x86_64.rpm", "OpenChamber-2.5.2-linux-aarch64.rpm")] }


class InstallerTests(unittest.TestCase):
    def test_selection_matrix_and_unsupported(self):
        for distro, cpu, suffix in (
            ("arch", "x86_64", "x86_64.pkg.tar.zst"), ("ubuntu", "x86_64", "amd64.deb"),
            ("debian", "aarch64", "arm64.deb"), ("fedora", "x86_64", "x86_64.rpm"),
            ("nobara", "aarch64", "aarch64.rpm"), ("opensuse", "x86_64", "x86_64.rpm"),
        ):
            with self.subTest(distro=distro, cpu=cpu):
                family, arch = M.distro(f'ID="{distro}"', cpu)
                self.assertTrue(M.select_asset(release(), family, arch)["name"].endswith(suffix))
        for text, cpu in (("ID=alpine", "x86_64"), ("ID=arch", "aarch64"),
                          ("ID=arch", "riscv64"), ("ID=arch\nID_LIKE=debian", "x86_64")):
            with self.assertRaises(ValueError):
                M.distro(text, cpu)
        r = release()
        r["assets"].append(copy.deepcopy(r["assets"][0]))
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            M.select_asset(r, "arch", "x86_64")
        with self.assertRaises(ValueError):
            M.select_asset({**release(), "prerelease": True}, "deb", "x86_64")
        with self.assertRaises(ValueError):
            M.select_asset({**release(), "assets": []}, "deb", "x86_64")

    def test_checksum_gate(self):
        with tempfile.TemporaryDirectory() as folder:
            scratch = Path(folder)
            r = release()
            package = r["assets"][0]
            sums = f"{package['digest'][7:]}  {package['name']}\n".encode()
            r["assets"].append(asset("SHA256SUMS", sums))

            def fetch(url, path, **kwargs):
                path.write_bytes(sums if url.endswith("/SHA256SUMS") else b"package")
                return True

            with patch.object(M, "download", side_effect=fetch):
                self.assertEqual(M.desktop_package(r, "arch", "x86_64", scratch).read_bytes(), b"package")
                for failure in ("package", "sums", "missing"):
                    bad = copy.deepcopy(r)
                    if failure == "package":
                        bad["assets"][0]["digest"] = "sha256:" + "0" * 64
                    elif failure == "sums":
                        bad["assets"][-1]["digest"] = ""
                    else:
                        bad["assets"].pop()
                    with self.assertRaises(ValueError):
                        M.desktop_package(bad, "arch", "x86_64", scratch)

    def test_network_http_and_partial_failures(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(M, "tool", return_value="/mock/curl"):
            target = Path(folder) / "download"
            with patch.object(M, "command", return_value=result("404", 22)):
                self.assertFalse(M.download(M.API + "missing", target, allow_missing=True))
                with self.assertRaises(ValueError):
                    M.download(M.API + "missing", target)
            with patch.object(M, "command", return_value=result("403", 22)):
                with self.assertRaises(ValueError):
                    M.download(M.API + "limited", target, allow_missing=True)
            with patch.object(M, "command", side_effect=ValueError("curl partial transfer")):
                with self.assertRaisesRegex(ValueError, "partial"):
                    M.download(M.API + "partial", target)
            with self.assertRaises(ValueError):
                M.download("http://example.invalid/file", target)

    def test_safe_config_and_backups(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            config = home / "profile/opencode.json"
            config.parent.mkdir()
            original = b'{"providers":{"keep":{"key":"private"}},"plugins":["other"],"custom":true}\n'
            config.write_bytes(original)
            raw, obj = M.config_snapshot(config, home)
            versions = home / "data/advisory-nudges"
            target = versions / ("commit-" + "a" * 40)
            merged = M.merge_config(obj, target, versions)
            self.assertEqual(merged["providers"], obj["providers"])
            self.assertTrue(merged["custom"])
            self.assertEqual(merged["plugins"][0], "other")
            self.assertTrue(all(not mode["enabled"] for mode in merged["plugins"][1]["options"].values()))
            M.commit_config(config, home, raw, merged)
            backups = list(config.parent.glob("*.backup-*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), original)
            self.assertEqual(backups[0].stat().st_mode & 0o777, 0o600)
            installed = config.read_bytes()
            M.commit_config(config, home, installed, merged)
            self.assertEqual(config.read_bytes(), installed)
            self.assertEqual(len(list(config.parent.glob("*.backup-*"))), 1)
            merged["plugins"][1]["options"]["timer"]["enabled"] = True
            updated = M.merge_config(merged, versions / ("commit-" + "b" * 40), versions)
            self.assertTrue(updated["plugins"][1]["options"]["timer"]["enabled"])
            self.assertEqual(len(updated["plugins"]), 2)
            global_options = {"scope": "all", "auditPath": str(home / "private/audit.jsonl"),
                              "timer": {"enabled": True, "everyMs": 60000},
                              "observer": {"enabled": False}, "repetition": {"enabled": False}}
            merged["plugins"][1]["options"] = global_options
            promoted = M.merge_config(merged, versions / ("commit-" + "c" * 40), versions)
            self.assertEqual(promoted["plugins"][1]["options"], global_options)
            self.assertEqual(promoted["providers"], obj["providers"])
            global_options["rules"] = {"enabled": True, "file": str(home / "private/rules.json")}
            promoted = M.merge_config(merged, versions / ("commit-" + "d" * 40), versions)
            self.assertEqual(promoted["plugins"][1]["options"], global_options)
            config.write_text('{"changed":true}')
            with self.assertRaisesRegex(ValueError, "changed"):
                M.commit_config(config, home, installed, updated)

    def test_unsafe_config_refused_without_writes(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            config = home / "opencode.json"
            for raw in ('{"x":1,"x":2}', '{"x":NaN}', '// comment\n{}', '[]', '{"plugins":{}}'):
                config.write_text(raw)
                with self.assertRaises((ValueError, json.JSONDecodeError)):
                    M.config_snapshot(config, home)
                self.assertEqual(config.read_text(), raw)
            config.write_text("{}")
            other = home / "opencode.jsonc"
            other.write_text("{}")
            with self.assertRaisesRegex(ValueError, "JSONC"):
                M.config_snapshot(config, home)
            other.unlink()
            link = home / "link"
            link.symlink_to(home, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "Symlink"):
                M.config_snapshot(link / "opencode.json", home)
            os.chmod(config, 0o666)
            with self.assertRaisesRegex(ValueError, "Writable"):
                M.config_snapshot(config, home)
            os.chmod(config, 0o600)
            os.link(config, home / "hardlink.json")
            with self.assertRaisesRegex(ValueError, "one link"):
                M.config_snapshot(config, home)
            for obj in ({"plugins": ["opencode-advisory-nudges"]},
                        {"plugins": [{"package": str(home / "versions/a")}, {"package": str(home / "versions/b")}]},
                        {"plugin": [str(home / "versions/a")]}):
                with self.assertRaises(ValueError):
                    M.merge_config(obj, home / "versions/c", home / "versions")

    def test_atomic_write_failure_and_new_profile(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            config = home / "profile/opencode.json"
            M.commit_config(config, home, None, {"plugins": []})
            original = config.read_bytes()
            self.assertEqual(list(config.parent.glob("*.backup-*")), [])
            with patch.object(M.os, "replace", side_effect=OSError("simulated write failure")):
                with self.assertRaises(OSError):
                    M.commit_config(config, home, original, {"plugins": [], "custom": True})
            self.assertEqual(config.read_bytes(), original)
            backups = list(config.parent.glob("*.backup-*"))
            self.assertEqual(len(backups), 1)
            self.assertEqual(backups[0].read_bytes(), original)
            self.assertEqual(list(config.parent.glob(".opencode-install-*")), [])

    def test_running_host_refuses_without_interrupt(self):
        with tempfile.TemporaryDirectory() as folder:
            proc = Path(folder) / "9999999"
            proc.mkdir()
            cmdline = proc / "cmdline"
            original_iter = Path.iterdir
            for binary in ("/opt/OpenChamber/openchamber", "/opt/OpenChamber/resources/opencode"):
                cmdline.write_bytes(binary.encode() + b"\0")
                with patch.object(Path, "iterdir", lambda p: iter([proc]) if str(p) == "/proc" else original_iter(p)):
                    with self.assertRaisesRegex(ValueError, "Quit OpenChamber"):
                        M.quiet()

    def test_plugin_release_and_unsafe_archives(self):
        files = {n: (ROOT / n).read_bytes() for n in M.FILES}

        def archive(kind):
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode="w:gz") as tar:
                for name, data in files.items():
                    entry = tarfile.TarInfo("package/" + name)
                    entry.size = len(data)
                    if name == "index.js" and kind == "traversal":
                        entry.name = "../index.js"
                    if name == "index.js" and kind == "symlink":
                        entry.type, entry.linkname, entry.size = tarfile.SYMTYPE, "/etc/passwd", 0
                    tar.addfile(entry, io.BytesIO(data) if entry.isfile() else None)
            return output.getvalue()

        with tempfile.TemporaryDirectory() as folder:
            for kind in ("safe", "traversal", "symlink"):
                raw = archive(kind)
                r = {"tag_name": "v0.1.0", "assets": [asset("plugin.tgz", raw, M.PLUGIN, "v0.1.0")]}
                with patch.object(M, "api", return_value=r), patch.object(
                    M, "download", side_effect=lambda url, path, **kwargs: path.write_bytes(raw)
                ):
                    if kind == "safe":
                        found, revision, label = M.plugin_files(Path(folder))
                        self.assertEqual(found, files)
                        self.assertEqual(label, "v0.1.0")
                        self.assertTrue(revision.startswith("release-"))
                    else:
                        with self.assertRaisesRegex(ValueError, "Unsafe plugin archive"):
                            M.plugin_files(Path(folder))

    def test_plugin_main_pinned_once_and_git_blob_integrity(self):
        files = {n: (ROOT / n).read_bytes() for n in M.FILES}
        commit = "c" * 40
        entries = [{"path": n, "type": "blob", "mode": "100644", "size": len(raw),
                    "sha": hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()}
                   for n, raw in files.items()]
        calls = []

        def api(path, scratch, optional=False):
            calls.append(path)
            if path.endswith("/releases/latest"):
                return None
            if path.endswith("/commits/main"):
                return {"sha": commit}
            self.assertEqual(path, M.PLUGIN + "/git/trees/" + commit)
            return {"tree": entries}

        def fetch(url, path, **kwargs):
            self.assertIn("/" + commit + "/", url)
            path.write_bytes(files[path.name])

        with tempfile.TemporaryDirectory() as folder, patch.object(M, "api", side_effect=api), \
                patch.object(M, "download", side_effect=fetch):
            found, revision, label = M.plugin_files(Path(folder))
            self.assertEqual(found, files)
            self.assertEqual(revision, "commit-" + commit)
            self.assertEqual(label, commit)
            self.assertEqual(calls.count(M.PLUGIN + "/commits/main"), 1)
            entries[0]["sha"] = "0" * 40
            with self.assertRaisesRegex(ValueError, "Git blob mismatch"):
                M.plugin_files(Path(folder))

    def test_root_and_missing_config_refused(self):
        with patch.object(M.os, "geteuid", return_value=0):
            with self.assertRaisesRegex(ValueError, "never root"):
                M.main([])
        with self.assertRaisesRegex(ValueError, "Pass --config"):
            M.main([])

    def test_manager_detection_requires_native_tools(self):
        with patch.object(M, "system_tool", side_effect=lambda n: "/mock/" + n), \
                patch.object(M.shutil, "which", return_value=None):
            self.assertEqual(M.manager("arch")["pacman"], "/mock/pacman")
            self.assertEqual(M.manager("deb")["apt-get"], "/mock/apt-get")
            self.assertEqual(M.manager("rpm", "ID=opensuse")["install"], "/mock/zypper")
            self.assertEqual(M.manager("rpm", "ID=fedora")["install"], "/mock/dnf")
        with patch.object(M, "system_tool", side_effect=ValueError("missing")):
            with self.assertRaises(ValueError):
                M.manager("arch")

    def test_native_package_manager_dispatch_and_no_downgrade(self):
        for family, cpu in (("arch", "x86_64"), ("deb", "aarch64"), ("rpm", "x86_64")):
            tools = {n: "/mock/" + n for n in ("pacman", "vercmp", "dpkg-deb", "dpkg-query", "dpkg", "apt-get", "rpm")}
            tools["install"] = "/mock/dnf"
            tools["flavor"] = "dnf"
            for installed in (None, "2.4.0", "2.5.2", "9.0.0"):
                with self.subTest(family=family, installed=installed):
                    def run(args, codes=(0,)):
                        name = Path(args[0]).name
                        if name == "pacman":
                            return result("Name : openchamber-desktop\nVersion : 2.5.2-1\nArchitecture : x86_64\n" if "-Qip" in args else
                                          f"openchamber-desktop {installed}-1", 0 if "-Qip" in args or installed else 1,
                                          "" if installed else "error: package 'openchamber-desktop' was not found")
                        if name == "vercmp":
                            return result("-1" if installed == "2.4.0" else "0" if installed == "2.5.2" else "1")
                        if name == "dpkg-deb":
                            return result({"Package": "openchamber", "Version": "2.5.2", "Architecture": "arm64"}[args[-1]])
                        if name == "dpkg-query":
                            return result(f"install ok installed\n{installed}" if installed else "", 0 if installed else 1,
                                          "" if installed else "dpkg-query: no packages found matching openchamber")
                        if name == "dpkg":
                            return result(code=1 if installed == "2.4.0" else 0)
                        if name == "rpm":
                            if "--eval" in args:
                                return result("-1" if installed == "2.4.0" else "0" if installed == "2.5.2" else "1")
                            return result(f"openchamber\n0:{'2.5.2' if '-qp' in args else installed}-1\nx86_64"
                                          if "-qp" in args or installed else "package openchamber is not installed",
                                          0 if "-qp" in args or installed else 1)
                        self.fail(args)
                    with patch.object(M, "command", side_effect=run):
                        install, args = M.package_plan(family, cpu, Path("/tmp/package"), tools, "2.5.2")
                    self.assertEqual(install, installed in (None, "2.4.0"))
                    self.assertEqual(Path(args[0]).name, {"arch": "pacman", "deb": "apt-get", "rpm": "dnf"}[family])
                    self.assertFalse(any("downgrade" in str(a) or "sudo" in str(a) for a in args))
                    if family == "rpm":
                        with patch.object(M, "command", side_effect=run):
                            _, zypper = M.package_plan(family, cpu, Path("/tmp/package"),
                                                      {**tools, "install": "/mock/zypper", "flavor": "zypper"}, "2.5.2")
                        self.assertEqual(zypper[:3], ["/mock/zypper", "--non-interactive", "--no-refresh"])

    @unittest.skipUnless(shutil.which("pacman") and shutil.which("vercmp"), "read-only native pacman tools not present")
    def test_real_pacman_metadata_on_disposable_package(self):
        with tempfile.TemporaryDirectory() as folder:
            package = Path(folder) / "fixture.pkg.tar.gz"
            metadata = b"pkgname = openchamber-desktop\npkgver = 2.5.2-1\narch = x86_64\npkgdesc = inert fixture\nsize = 0\n"
            with tarfile.open(package, "w:gz") as tar:
                entry = tarfile.TarInfo(".PKGINFO")
                entry.size = len(metadata)
                tar.addfile(entry, io.BytesIO(metadata))
            original = M.command

            def query(args, codes=(0,)):
                if args[1] == "-Q":
                    return result(code=1, stderr="error: package 'openchamber-desktop' was not found")
                return original(args, codes)

            with patch.object(M, "command", side_effect=query):
                needed, args = M.package_plan("arch", "x86_64", package, M.manager("arch"), "2.5.2")
            self.assertTrue(needed)
            self.assertEqual(args[1:4], ["-U", "--needed", "--noconfirm"])

    def test_main_install_update_repeat_and_preflight_failures(self):
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            config = home / "profile/opencode.json"
            config.parent.mkdir()
            config.write_text('{"providers":{"retained":{}},"plugins":["other"]}')
            before = config.read_bytes()
            files = {name: (ROOT / name).read_bytes() for name in M.FILES}
            state = {"installed": False, "revision": "a" * 40}
            r = release()
            calls = []

            def fetch(url, target, **kwargs):
                target.write_text('{"opencodeCli":{"version":"2.1.4"}}')
                return True

            def plan(*args):
                return not state["installed"], ["/mock/pacman", "-U", args[2]]

            def install(args):
                calls.append(args)
                state["installed"] = True
                return result()

            original_read = Path.read_text
            with redirect_stdout(io.StringIO()), \
                    patch.dict(os.environ, {"HOME": str(home), "XDG_DATA_HOME": str(home / "data"),
                                         "OPENCODE_CONFIG_CONTENT": ""}), \
                    patch.object(M, "quiet"), patch.object(M, "manager", return_value={}), \
                    patch.object(M, "system_tool", return_value="/mock/pkexec"), \
                    patch.object(M, "api", return_value=r), patch.object(M, "download", side_effect=fetch), \
                    patch.object(M, "desktop_package", return_value=home / "verified-package"), \
                    patch.object(M, "plugin_files", side_effect=lambda _: (files, "commit-" + state["revision"], state["revision"])), \
                    patch.object(M, "package_plan", side_effect=plan), \
                    patch.object(M.subprocess, "run", side_effect=install), \
                    patch.object(M.platform, "machine", return_value="x86_64"), \
                    patch.object(Path, "read_text", lambda path, *a, **kw: "ID=arch" if str(path) == "/etc/os-release" else original_read(path, *a, **kw)):
                M.main(["--config", str(config), "--dry-run"])
                self.assertEqual(config.read_bytes(), before)
                self.assertFalse((home / "data").exists())
                for failure in ("network", "checksum", "plugin", "identity"):
                    name = {"network": "api", "checksum": "desktop_package", "plugin": "plugin_files",
                            "identity": "package_plan"}[failure]
                    with patch.object(M, name, side_effect=ValueError(failure)):
                        with self.assertRaises(ValueError):
                            M.main(["--config", str(config)])
                    self.assertEqual(config.read_bytes(), before)
                    self.assertFalse((home / "data").exists())
                    self.assertFalse(calls)
                M.main(["--config", str(config)])
                self.assertEqual(len(calls), 1)
                self.assertEqual(calls[0][:3], ["/mock/pkexec", "--disable-internal-agent", "/mock/pacman"])
                first = config.read_bytes()
                M.main(["--config", str(config)])
                self.assertEqual(len(calls), 1)
                self.assertEqual(config.read_bytes(), first)
                state["revision"] = "b" * 40
                M.main(["--config", str(config)])
                obj = json.loads(config.read_bytes())
                self.assertEqual(obj["providers"], {"retained": {}})
                self.assertEqual(obj["plugins"][0], "other")
                self.assertEqual(len(obj["plugins"]), 2)
                self.assertTrue(obj["plugins"][1]["package"].endswith("b" * 40))
                self.assertTrue(all(not m["enabled"] for m in obj["plugins"][1]["options"].values()))
                self.assertTrue(Path(json.loads(first)["plugins"][1]["package"]).is_dir())
                self.assertEqual(len(list(config.parent.glob("*.backup-*"))), 2)
                state["installed"] = False
                state["revision"] = "d" * 40
                before_failure = config.read_bytes()
                with patch.object(M.subprocess, "run", return_value=result(code=126)):
                    with self.assertRaisesRegex(ValueError, "cancelled"):
                        M.main(["--config", str(config)])
                self.assertEqual(config.read_bytes(), before_failure)
                self.assertFalse((home / "data/openchamber/advisory-nudges" / ("commit-" + "d" * 40)).exists())


if __name__ == "__main__":
    unittest.main()
