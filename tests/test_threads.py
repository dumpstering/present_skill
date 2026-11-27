"""Unit tests for threads.py: run with `python3 -m unittest tests/test_threads.py` from the skill folder."""
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import threads  # noqa: E402


def write_jsonl(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8")


class DigestTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.env = {"CLAUDE_CONFIG_DIR": str(root / "claude"), "CODEX_HOME": str(root / "codex"),
                    "PI_SESSIONS": str(root / "pi")}
        self.saved = {k: os.environ.get(k) for k in self.env}
        os.environ.update(self.env)
        ts = "2026-11-26T20:00:00Z"
        proj = root / "claude" / "projects" / "-tmp-proj"
        write_jsonl(proj / "aaaa1111.jsonl", [
            {"type": "ai-title", "aiTitle": "Fix the slide splitter"},
            {"type": "user", "cwd": "/tmp/proj", "timestamp": ts, "message": {"content": "split tall slides"}},
            {"type": "user", "isMeta": True, "timestamp": ts, "message": {"content": "<command-name>x</command-name>"}},
            {"type": "assistant", "timestamp": ts, "message": {"content": [{"type": "text", "text": "Done. Should I merge PR #3?"}]}},
        ])
        write_jsonl(proj / "bbbb2222.jsonl", [
            {"type": "user", "cwd": "/tmp/proj", "timestamp": ts, "message": {"content": "add live timestamps"}},
            {"type": "assistant", "timestamp": ts, "message": {"content": [{"type": "text", "text": "Starting."}]}},
            {"type": "user", "timestamp": ts, "message": {"content": [{"type": "text", "text": "[Request interrupted by user for tool use]"}]}},
        ])
        write_jsonl(proj / "subagents" / "cccc3333.jsonl", [
            {"type": "user", "cwd": "/tmp/proj", "timestamp": ts, "message": {"content": "subagent work"}},
        ])
        write_jsonl(root / "codex" / "sessions" / "2026" / "11" / "26" / "rollout-x.jsonl", [
            {"type": "session_meta", "timestamp": ts, "payload": {"id": "cdx-1", "cwd": "/tmp/other"}},
            {"type": "response_item", "timestamp": ts, "payload": {"type": "message", "role": "user",
             "content": [{"type": "input_text", "text": "<environment_context>ignored</environment_context>"}]}},
            {"type": "response_item", "timestamp": ts, "payload": {"type": "message", "role": "user",
             "content": [{"type": "input_text", "text": "audit the budget sheet"}]}},
            {"type": "event_msg", "timestamp": ts, "payload": {"type": "task_complete", "last_agent_message": "Found 3 gaps."}},
        ])
        write_jsonl(root / "pi" / "--tmp--" / "p1.jsonl", [
            {"type": "session", "id": "pi-main", "cwd": "/tmp/pi", "timestamp": ts},
            {"type": "message", "timestamp": ts, "message": {"role": "user", "content": [{"type": "text", "text": "tidy the notes"}]}},
            {"type": "message", "timestamp": ts, "message": {"role": "assistant", "content": [{"type": "text", "text": "Tidied."}]}},
        ])
        write_jsonl(root / "pi" / "--tmp--" / "p2.jsonl", [
            {"type": "session", "id": "pi-worker", "parentSession": "pi-main", "cwd": "/tmp/pi", "timestamp": ts},
            {"type": "message", "timestamp": ts, "message": {"role": "user", "content": [{"type": "text", "text": "worker task"}]}},
        ])
        self.text = threads.digest(threads.window_seconds("1d"), exclude="", use_gh=False, now=time.time())

    def tearDown(self):
        for k, v in self.saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        self.tmp.cleanup()

    def test_reads_main_sessions_from_all_three_tools(self):
        self.assertIn("## claude aaaa1111: Fix the slide splitter", self.text)
        self.assertIn("## codex cdx-1: audit the budget sheet", self.text)
        self.assertIn("## pi pi-main: tidy the notes", self.text)
        self.assertEqual(self.text.count("\n## "), 4)

    def test_skips_subagents_child_sessions_and_injected_context(self):
        for hidden in ("subagent work", "worker task", "environment_context", "command-name"):
            self.assertNotIn(hidden, self.text)

    def test_flags_open_endings(self):
        claude_a = self.text.split("## claude aaaa1111")[1].split("\n## ")[0]
        claude_b = self.text.split("## claude bbbb2222")[1].split("\n## ")[0]
        self.assertIn("flags: ends with a question", claude_a)
        self.assertIn("flags: interrupted", claude_b)

    def test_resume_commands_per_tool(self):
        self.assertIn("`cd /tmp/proj && claude --resume aaaa1111`", self.text)
        self.assertIn("`cd /tmp/other && codex resume cdx-1`", self.text)
        self.assertIn("`cd /tmp/pi && pi --session pi-main`", self.text)

    def test_exclude_drops_the_running_session(self):
        text = threads.digest(threads.window_seconds("1d"), exclude="aaaa1111", use_gh=False)
        self.assertNotIn("aaaa1111", text)

    def test_window_parsing(self):
        self.assertEqual(threads.window_seconds("4h"), 4 * 3600)
        self.assertEqual(threads.window_seconds("1m"), 30 * 86400)
        with self.assertRaises(ValueError):
            threads.window_seconds("soon")


if __name__ == "__main__":
    unittest.main()
