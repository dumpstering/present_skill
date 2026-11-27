"""Runtime files go to the data folder, not the code folder: a plugin update replaces the code folder.
Run with `python3 -m unittest tests/test_data_dir.py` from the repo root."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "skills" / "present" / "present.py"


def run(env_extra, *args):
    env = {k: v for k, v in os.environ.items() if not k.startswith(("PRESENT_", "CLAUDE_PLUGIN_"))}
    env.update(env_extra)
    return subprocess.run([sys.executable, "-I", str(SCRIPT), *args], input="# Hi\n\nA short reply.\n",
                          capture_output=True, text=True, env=env, timeout=30)


class DataDirTest(unittest.TestCase):
    def check_lands_in(self, var):
        with tempfile.TemporaryDirectory() as data:
            r = run({var: data}, "show", "-", "--session=datadirtest", "--no-open")
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertTrue((Path(data) / "out" / "datadirt.html").exists(), r.stdout)
            self.assertTrue((Path(data) / "present.log").exists())
            r = run({var: data}, "off")
            self.assertTrue((Path(data) / "OFF").exists(), r.stdout)
            self.assertFalse((SCRIPT.parent / "out" / "datadirt.html").exists())

    def test_hooks_use_claude_plugin_data(self):
        self.check_lands_in("CLAUDE_PLUGIN_DATA")

    def test_skill_commands_use_present_data(self):
        self.check_lands_in("PRESENT_DATA")

    def test_creates_a_missing_data_folder(self):
        with tempfile.TemporaryDirectory() as parent:
            data = Path(parent) / "not" / "yet"
            r = run({"PRESENT_DATA": str(data)}, "show", "-", "--session=datadirtest", "--no-open")
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
            self.assertTrue((data / "out" / "datadirt.html").exists())


if __name__ == "__main__":
    unittest.main()
