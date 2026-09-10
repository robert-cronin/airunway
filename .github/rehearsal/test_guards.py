"""Offline guards and real Git pushes to temporary local fixtures, with no network."""

import os
from pathlib import Path
import shutil
import shlex
import subprocess
import sys
import tempfile
import unittest

from guard import FAMILIES, IMAGE_PREFIX


HERE = Path(__file__).resolve().parent
ZERO = "0" * 40
BRANCH = "refs/heads/rehearsal/v0.8.0"
TAG = "refs/tags/v0.8.0"
FORK = "git@github.com:robert-cronin/airunway.git"


class PublicationGuardTests(unittest.TestCase):
    def check_guard(self, *, tags=None, overrides=None, event="push", mode="tags", ok=False):
        with tempfile.TemporaryDirectory(prefix="fork-tags-test-") as directory:
            output = Path(directory) / "output"
            env = {
                "PATH": os.environ["PATH"],
                "GITHUB_REPOSITORY": "robert-cronin/airunway",
                "GITHUB_REF": TAG,
                "GITHUB_EVENT_NAME": event,
                "GITHUB_OUTPUT": str(output),
                "REHEARSAL_VERSION": "0.8.0",
                "REHEARSAL_IMAGE_FAMILY": "dashboard",
                "REHEARSAL_TAGS": tags if tags is not None else f"{IMAGE_PREFIX}/dashboard:0.8.0",
            }
            env.update(overrides or {})
            result = subprocess.run(
                [sys.executable, str(HERE / "guard.py"), mode, event],
                env=env, text=True, capture_output=True, check=False,
            )
            payload = output.read_text() if output.exists() else ""
            if ok:
                self.assertEqual(result.returncode, 0, result.stderr)
                if mode == "tags":
                    self.assertEqual(payload, "tags<<FORK_REHEARSAL_TAGS\n" +
                                     "\n".join(env["REHEARSAL_TAGS"].splitlines()) +
                                     "\nFORK_REHEARSAL_TAGS\n")
            else:
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(payload, "", "rejected input must expose no partial tag output")

    def test_all_fifteen_families(self):
        for family in sorted(FAMILIES):
            with self.subTest(family=family):
                tags = "\n".join(f"{IMAGE_PREFIX}/{family}:{tag}" for tag in
                                 ("0.8.0", "0.8", "0", "latest", "abcdef0")) + "\n"
                self.check_guard(tags=tags, overrides={"REHEARSAL_IMAGE_FAMILY": family}, ok=True)

    def test_provider_dispatch(self):
        self.check_guard(event="workflow_dispatch", ok=True)
        self.check_guard(event="workflow_dispatch", overrides={"REHEARSAL_VERSION": "v0.8.0"})
        self.check_guard(event="workflow_dispatch", overrides={"REHEARSAL_VERSION": "0.9.0"})

    def test_wrong_context(self):
        for key, value in (
            ("GITHUB_REPOSITORY", "ai-runway/airunway"),
            ("GITHUB_REPOSITORY", "kaito-project/airunway"),
            ("GITHUB_REPOSITORY", "robert-cronin/airunway-elsewhere"),
            ("GITHUB_REPOSITORY", ""),
            ("GITHUB_REF", "refs/heads/main"),
            ("GITHUB_REF", "refs/heads/rehearsal/v0.8.0"),
            ("GITHUB_REF", "refs/tags/v0.8.0-rc.1"),
            ("GITHUB_EVENT_NAME", "pull_request"),
            ("GITHUB_EVENT_NAME", "workflow_dispatch"),
        ):
            with self.subTest(key=key, value=value):
                self.check_guard(overrides={key: value})
                self.check_guard(overrides={key: value}, mode="context")
        self.check_guard(mode="context", ok=True)

    def test_wrong_destinations(self):
        for image in (
            "ghcr.io/ai-runway/airunway/dashboard",
            "ghcr.io/kaito-project/airunway/dashboard",
            "ghcr.io/robert-cronin/airunway/dashboard",
            IMAGE_PREFIX + "-elsewhere/dashboard",
            IMAGE_PREFIX + "/controller",
            "docker.io/robert-cronin/dashboard",
        ):
            with self.subTest(image=image):
                bad = image + ":0.8.0"
                self.check_guard(tags=bad)
                self.check_guard(tags=f"{IMAGE_PREFIX}/dashboard:0.8.0\n{bad}")

    def test_empty_malformed_and_missing_version(self):
        valid = f"{IMAGE_PREFIX}/dashboard:0.8.0"
        for tags in ("", "\n", " ", valid + "\n\n", " " + valid, valid + " ",
                     valid + "," + valid, valid + "/other", valid + "@sha256:" + "a" * 64,
                     valid + "\nFORK_REHEARSAL_TAGS\nother=value",
                     f"{IMAGE_PREFIX}/dashboard:latest", f"{IMAGE_PREFIX}/dashboard:" + "a" * 129):
            with self.subTest(tags=tags):
                self.check_guard(tags=tags)
        self.check_guard(overrides={"REHEARSAL_IMAGE_FAMILY": "../dashboard"})
        self.check_guard(overrides={"GITHUB_OUTPUT": ""})


class PrePushHookTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="fork-hook-test-")
        cls.root = Path(cls.temporary.name)
        cls.env = {
            "PATH": os.environ["PATH"],
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_AUTHOR_NAME": "Fork guard test", "GIT_COMMITTER_NAME": "Fork guard test",
            "GIT_AUTHOR_EMAIL": "test@example.invalid", "GIT_COMMITTER_EMAIL": "test@example.invalid",
        }
        cls.git("init", "--quiet")
        cls.git("-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "base fixture")
        cls.base = cls.git("rev-parse", "HEAD")
        cls.git("-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "reviewed fixture")
        cls.commit = cls.git("rev-parse", "HEAD")
        cls.git("-c", "tag.gpgsign=false", "tag", "-a", "v0.8.0", "-m", "fixture")
        cls.tag_oid = cls.git("rev-parse", "refs/tags/v0.8.0")
        cls.hook = cls.root / "pre-push"
        shutil.copyfile(HERE / "pre-push", cls.hook)
        cls.pin = cls.root / "rehearsal-expected-commit"
        cls.pin.write_text(cls.commit + "\n")

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    @classmethod
    def git(cls, *args):
        return subprocess.check_output(["git", *args], cwd=cls.root, env=cls.env,
                                       text=True, stderr=subprocess.DEVNULL).strip()

    def update(self, ref=BRANCH, oid=None, remote_oid=ZERO):
        return f"{ref} {oid or self.commit} {ref} {remote_oid}\n"

    def check_hook(self, updates=None, url=FORK, ok=False, allowed_ref=BRANCH):
        env = dict(self.env, AIRUNWAY_FORK_REHEARSAL_PUSH_REF=allowed_ref)
        result = subprocess.run(
            [sys.executable, str(self.hook), "origin", url],
            input=self.update() if updates is None else updates,
            cwd=self.root, env=env, text=True, capture_output=True, check=False,
        )
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0)

    def test_fork_branch_and_tags(self):
        for url in (FORK, "ssh://git@github.com/robert-cronin/airunway.git",
                    "https://github.com/robert-cronin/airunway.git"):
            self.check_hook(url=url, ok=True)
        self.check_hook(self.update(TAG), ok=True, allowed_ref=TAG)
        self.check_hook(self.update(TAG, self.tag_oid), ok=True, allowed_ref=TAG)
        self.check_hook(self.update() + self.update(TAG, self.tag_oid))
        self.check_hook(self.update(remote_oid=self.base), ok=True)

    def test_direct_push_requires_entry_point(self):
        self.check_hook(allowed_ref="")

    def test_other_destinations(self):
        for url in ("git@github.com:ai-runway/airunway.git", "https://github.com/ai-runway/airunway.git",
                    "git@github.com:kaito-project/airunway.git", "https://github.com/kaito-project/airunway.git",
                    "git@github.com:robert-cronin/airunway-elsewhere.git", FORK + "/extra", ""):
            with self.subTest(url=url):
                self.check_hook(url=url)

    def test_other_refs_and_mixed_updates(self):
        for ref in ("refs/heads/main", "refs/heads/rehearsal/v0.9.0", "refs/tags/v0.7.0"):
            self.check_hook(self.update(ref))
            self.check_hook(self.update() + self.update(ref))
        self.check_hook(f"HEAD {self.commit} {BRANCH} {ZERO}\n")
        self.check_hook(self.update() + self.update())

    def test_deletions_rewrites_and_unreviewed_commits(self):
        self.check_hook(self.update(oid=ZERO))
        self.check_hook(f"(delete) {ZERO} {TAG} {self.tag_oid}\n", allowed_ref=TAG)
        self.check_hook(self.update(TAG, self.tag_oid, self.tag_oid), allowed_ref=TAG)
        self.check_hook(self.update(oid=self.base))
        self.check_hook(self.update(remote_oid="f" * 40))

    def test_missing_pin_and_malformed_input(self):
        self.pin.unlink()
        try:
            self.check_hook()
        finally:
            self.pin.write_text(self.commit + "\n")
        for updates in ("", "\n", "bad update\n", f"{BRANCH} bad {BRANCH} {ZERO}\n"):
            self.check_hook(updates)


class GitPushIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="fork-git-integration-")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.local = self.directory / "local"
        self.remote = self.directory / "remote.git"
        self.env = {
            "PATH": os.environ["PATH"],
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_AUTHOR_NAME": "Fork guard test", "GIT_COMMITTER_NAME": "Fork guard test",
            "GIT_AUTHOR_EMAIL": "test@example.invalid", "GIT_COMMITTER_EMAIL": "test@example.invalid",
            "GIT_SSH_VARIANT": "ssh", "GIT_ALLOW_PROTOCOL": "file:ssh",
            "FORK_TEST_REMOTE": str(self.remote),
        }
        # Git retains the real fork URL for hook validation, but this replacement
        # for ssh ONLY starts a local receive-pack. It never invokes ssh/network.
        shim = self.directory / "local-ssh.py"
        shim.write_text(
            "import os, sys\n"
            "assert 'git@github.com' in sys.argv\n"
            "assert sys.argv[-1] == \"git-receive-pack 'robert-cronin/airunway.git'\"\n"
            "os.execvp('git', ['git', 'receive-pack', os.environ['FORK_TEST_REMOTE']])\n"
        )
        self.env["GIT_SSH_COMMAND"] = shlex.join([sys.executable, str(shim)])
        self.run_git("init", "--quiet", "--initial-branch=main", str(self.local), cwd=self.directory)
        self.run_git("init", "--quiet", "--bare", str(self.remote), cwd=self.directory)
        self.entry = self.local / ".github/rehearsal/pre-push"
        self.entry.parent.mkdir(parents=True)
        shutil.copyfile(HERE / "pre-push", self.entry)
        self.entry.chmod(0o755)
        self.run_git("add", ".github")
        self.run_git("-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "base fixture")
        self.base = self.run_git("rev-parse", "HEAD").stdout.strip()
        self.run_git("fetch", "--quiet", str(self.local), "HEAD", cwd=self.remote)
        for ref in ("refs/heads/main", "refs/heads/do-not-delete", "refs/tags/keep-me"):
            self.run_git("update-ref", ref, self.base, cwd=self.remote)
        self.run_git("checkout", "--quiet", "-b", "rehearsal/v0.8.0")
        self.run_git("-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "reviewed fixture")
        self.commit = self.run_git("rev-parse", "HEAD").stdout.strip()
        hooks = self.local / ".git/fork-rehearsal-hooks"
        hooks.mkdir()
        shutil.copyfile(self.entry, hooks / "pre-push")
        (hooks / "pre-push").chmod(0o755)
        (hooks / "rehearsal-expected-commit").write_text(self.commit + "\n")
        self.run_git("config", "core.hooksPath", str(hooks))

    def run_git(self, *args, cwd=None, check=True):
        result = subprocess.run(["git", *args], cwd=cwd or self.local, env=self.env,
                                text=True, capture_output=True, check=False)
        if check:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def assert_protected_refs(self):
        for ref in ("refs/heads/main", "refs/heads/do-not-delete", "refs/tags/keep-me"):
            result = self.run_git("rev-parse", "--verify", ref, cwd=self.remote)
            self.assertEqual(result.stdout.strip(), self.base)

    def test_direct_mirror_push_is_blocked(self):
        result = self.run_git("push", "--mirror", FORK, check=False)
        self.assertNotEqual(result.returncode, 0, "the hook must reject mirror pushes")
        self.assert_protected_refs()

    def test_configuration_mirror_push_is_blocked(self):
        self.run_git("config", "remote.mirror-test.url", FORK)
        self.run_git("config", "remote.mirror-test.mirror", "true")
        result = self.run_git("push", "mirror-test", check=False)
        self.assertNotEqual(result.returncode, 0, "the hook must reject configured mirroring")
        self.assert_protected_refs()

    def test_safe_entry_point_overrides_mirroring_and_follow_tags(self):
        self.run_git("config", f"remote.{FORK}.url", FORK)
        self.run_git("config", f"remote.{FORK}.mirror", "true")
        self.run_git("config", "push.followTags", "true")
        self.run_git("-c", "tag.gpgsign=false", "tag", "-a", "local-only", self.base, "-m", "fixture")
        for selection, ref in (("branch", BRANCH), ("tag", TAG)):
            if selection == "tag":
                self.run_git("-c", "tag.gpgsign=false", "tag", "-a", "v0.8.0", "-m", "fixture")
            result = subprocess.run([sys.executable, str(self.entry), selection], cwd=self.local,
                                    env=self.env, text=True, capture_output=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            actual = self.run_git("rev-parse", f"{ref}^{{commit}}", cwd=self.remote)
            self.assertEqual(actual.stdout.strip(), self.commit)
            self.assert_protected_refs()
            self.assertNotEqual(self.run_git("show-ref", "--verify", "refs/tags/local-only",
                                            cwd=self.remote, check=False).returncode, 0)


if __name__ == "__main__":
    unittest.main()
