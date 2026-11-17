import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest


spec = importlib.util.spec_from_file_location("validate_pr_catalog", Path(__file__).with_name("validate_pr_catalog.py"))
validation = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validation)


class TrustedPullRequestCatalogTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="nzik-pr-scan-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Test")
        self.git("config", "user.email", "test@example.com")
        self.git("config", "core.autocrlf", "false")
        self.git("config", "core.filemode", "false")
        self.git("remote", "add", "origin", ".")
        self.put(".github/scripts/validate_catalog.py", "\n".join([
            "from pathlib import Path",
            'assert Path("catalog/themes/value.json").read_text() == "new"',
            'assert not Path("catalog/creators/deleted.json").exists()',
            'assert Path("catalog/schemas/example.json").read_text() == "trusted schema"',
            'assert Path("demo/example.json").read_text() == "trusted demo"',
            'assert not Path("requirements-validation.txt").exists()',
            'assert not Path("sitecustomize.py").exists()',
        ]))
        self.put("catalog/schemas/example.json", "trusted schema")
        self.put("demo/example.json", "trusted demo")
        self.put("catalog/themes/value.json", "old")
        self.put("catalog/themes/LICENSE-GPL-3.0.txt", "Catalog license")
        self.put("catalog/creators/deleted.json", "old")
        self.base = self.commit("Trusted base")

    def git(self, *args):
        return subprocess.check_output(["git", *args], cwd=self.root, stderr=subprocess.PIPE).decode().strip()

    def put(self, name, text):
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "-qm", message)
        return self.git("rev-parse", "HEAD")

    def pull(self, head, base=None):
        self.git("update-ref", "refs/pull/4/head", head)
        self.git("checkout", "--detach", "-q", base or self.base)
        return {"number": 4, "base": {"sha": base or self.base}, "head": {"sha": head}}

    def test_merged_data_additions_deletions_and_untrusted_code_are_isolated(self):
        self.put("catalog/themes/value.json", "new")
        self.put("catalog/creators/added.json", "new creator")
        (self.root / "catalog/creators/deleted.json").unlink()
        for name in (".github/scripts/validate_catalog.py", "sitecustomize.py"):
            self.put(name, "raise RuntimeError('Fork code must never execute')")
        self.put("requirements-validation.txt", "malicious-package")
        self.put("catalog/schemas/example.json", "untrusted schema")
        self.put("demo/example.json", "untrusted demo")
        head = self.commit("Fork changes")
        pull = self.pull(head)
        validation.validate_pull_request(self.root, pull)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.base)
        self.assertEqual((self.root / "catalog/themes/value.json").read_text(), "old")
        with tempfile.TemporaryDirectory() as temporary:
            validation.materialize(self.root, validation.candidate_tree(self.root, pull), Path(temporary))
            self.assertEqual((Path(temporary) / "catalog/creators/added.json").read_text(), "new creator")

    def test_code_only_pull_scans_base_data(self):
        self.put(".github/scripts/validate_catalog.py", "raise RuntimeError('untrusted')")
        head = self.commit("Code-only changes")
        pull = self.pull(head)
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary)
            validation.materialize(self.root, validation.candidate_tree(self.root, pull), destination)
            self.assertEqual((destination / "catalog/themes/value.json").read_text(), "old")
            self.assertEqual((destination / "catalog/themes/LICENSE-GPL-3.0.txt").read_text(), "Catalog license")
            self.assertEqual((destination / ".github/scripts/validate_catalog.py").read_text(),
                             (self.root / ".github/scripts/validate_catalog.py").read_text())

    def test_catalog_symlink_is_rejected_without_creating_links(self):
        blob = subprocess.check_output(["git", "hash-object", "-w", "--stdin"],
                                       cwd=self.root, input=b"../../.github/scripts/validate_catalog.py").decode().strip()
        self.git("update-index", "--add", "--cacheinfo", "120000", blob, "catalog/themes/link.json")
        self.git("commit", "-qm", "Untrusted symlink")
        head = self.git("rev-parse", "HEAD")
        pull = self.pull(head)
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "regular catalog data"):
                validation.materialize(self.root, validation.candidate_tree(self.root, pull), Path(temporary))

    def test_untrusted_executable_catalog_file_is_rejected(self):
        self.put("catalog/themes/payload.py", "raise RuntimeError('untrusted')")
        pull = self.pull(self.commit("Executable catalog payload"))
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "regular catalog data"):
                validation.materialize(self.root, validation.candidate_tree(self.root, pull), Path(temporary))

    def test_conflicting_merge_fails(self):
        self.put("catalog/themes/value.json", "fork")
        head = self.commit("Fork edit")
        self.git("checkout", "--detach", "-q", self.base)
        self.put("catalog/themes/value.json", "main")
        base = self.commit("Main edit")
        with self.assertRaises(subprocess.CalledProcessError):
            validation.candidate_tree(self.root, self.pull(head, base))

    def test_changed_head_and_wrong_checkout_fail(self):
        self.put("catalog/themes/value.json", "new")
        head = self.commit("Fork edit")
        pull = self.pull(head)
        with self.assertRaisesRegex(ValueError, "head changed"):
            validation.candidate_tree(self.root, {**pull, "head": {"sha": self.base}})
        with self.assertRaisesRegex(ValueError, "trusted checkout"):
            validation.candidate_tree(self.root, {**pull, "base": {"sha": head}})


if __name__ == "__main__":
    unittest.main()
