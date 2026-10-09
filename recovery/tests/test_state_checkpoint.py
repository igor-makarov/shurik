"""Offline tests for the crawl-state checkpoint (mocked registry, dummy creds)."""
from __future__ import annotations

import json
import os
import tempfile
import unittest

from recovery import oci, state_checkpoint


class _FakePuller:
    """Stands in for AnonymousPuller: no network, no credentials."""

    def __init__(self, manifest=None, blob=None, error=None):
        self._manifest = manifest
        self._blob = blob
        self.error = error
        self.seen = []

    def manifest(self, reference):
        self.seen.append(f"manifest {reference}")
        if self.error:
            raise RuntimeError(self.error)
        return self._manifest, "sha256:" + "0" * 64

    def blob(self, digest):
        self.seen.append(f"blob {digest[:19]}")
        return self._blob


class _FakeRegistry:
    def __init__(self):
        self.blobs = []
        self.manifests = {}

    def push_blob(self, blob):
        self.blobs.append(blob)
        return "pushed"

    def push_manifest(self, manifest_blob, tag):
        self.manifests[tag] = manifest_blob


class CheckpointRoundTripTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = self.tmp.name
        for rel, body in (("data/posts/100403945458.json", b'{"post_id": "100403945458", "x": 1}'),
                          ("data/cdx/posts.jsonl", b'{"url": "http://hazfalafel.com/post/1"}\n'),
                          ("data/image-queue.json", b'{"posts": {}}'),
                          ("data/missing.jsonl", b'{"key": "1"}\n'),
                          ("data/gaps.jsonl", b'{"media_url": "u"}\n')):
            path = os.path.join(self.root, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as fh:
                fh.write(body)

    def test_layer_carries_state_and_excludes_blobs(self):
        entries = state_checkpoint._collect(self.root)
        names = [n for n, _ in entries]
        self.assertIn("data/posts/100403945458.json", names)
        self.assertIn("data/cdx/posts.jsonl", names)
        self.assertIn("data/image-queue.json", names)
        self.assertFalse([n for n in names if n.startswith("data/blobs/")])

    def test_restore_round_trip_writes_files(self):
        payload = state_checkpoint.tar_gz_tree(state_checkpoint._collect(self.root))
        layer = {"digest": "sha256:" + "a" * 64, "mediaType": oci.LAYER_MEDIA_TYPE, "size": len(payload)}
        manifest = {"schemaVersion": 2, "mediaType": oci.MANIFEST_MEDIA_TYPE,
                    "config": {"digest": "sha256:" + "b" * 64, "size": 1,
                               "mediaType": oci.CONFIG_MEDIA_TYPE},
                    "layers": [layer],
                    "annotations": {"shurik.checkpoint.schema": "1"}}
        target = os.path.join(self.root, "out")
        os.makedirs(target)
        out = state_checkpoint.restore_state(target, puller=_FakePuller(manifest, payload))
        self.assertTrue(out["restored"], out)
        self.assertEqual(out["schema_version"], 1)
        self.assertTrue(os.path.exists(os.path.join(target, "data/posts/100403945458.json")))
        with open(os.path.join(target, "data/posts/100403945458.json"), "rb") as fh:
            self.assertEqual(fh.read(), b'{"post_id": "100403945458", "x": 1}')

    def test_missing_tag_is_reported_not_raised(self):
        out = state_checkpoint.restore_state(self.root, puller=_FakePuller(error="404"))
        self.assertFalse(out["restored"])
        self.assertIn("404", out["error"])

    def test_stale_registry_state_fills_missing_files_without_overwriting_progress(self):
        ledger = os.path.join(self.root, "data/missing.jsonl")
        queue = os.path.join(self.root, "data/image-queue.json")
        payload = state_checkpoint.tar_gz_tree([
            ("data/missing.jsonl", b"old-ledger\n"),
            ("data/image-queue.json", b"old-queue"),
            ("data/cdx/posts.jsonl", b"old-cache\n"),
            ("data/cdx/new.json", b'{"captures": ["new"]}'),
            ("PROMPT.md", b"unexpected"),
        ])
        preserved = []
        written = state_checkpoint._extract(payload, self.root, preserved)
        self.assertEqual(written, ["data/cdx/new.json"])
        self.assertEqual(len(preserved), 3)
        with open(ledger, "rb") as fh:
            self.assertEqual(fh.read(), b'{"key": "1"}\n')
        with open(queue, "rb") as fh:
            self.assertEqual(fh.read(), b'{"posts": {}}')
        with open(os.path.join(self.root, "data/cdx/posts.jsonl"), "rb") as fh:
            self.assertEqual(fh.read(), b'{"url": "http://hazfalafel.com/post/1"}\n')
        self.assertFalse(os.path.exists(os.path.join(self.root, "PROMPT.md")))

    def test_hostdump_pages_and_cursor_round_trip_together(self):
        # A partial host walk is only resumable when its rows and cursor travel
        # together; the checkpoint must carry both (data/work/hostdumps is the
        # raw rows, data/cdx/hostdump-cursors is the key).
        dump = os.path.join(self.root, "data/work/hostdumps/24.media.tumblr.com.jsonl")
        cursor = os.path.join(self.root, "data/cdx/hostdump-cursors/24.media.tumblr.com.cursor.json")
        os.makedirs(os.path.dirname(dump), exist_ok=True)
        os.makedirs(os.path.dirname(cursor), exist_ok=True)
        with open(dump, "wb") as fh:
            fh.write(b'{"urlkey": "k1"}\n{"urlkey": "k2"}\n')
        with open(cursor, "wb") as fh:
            fh.write(b'{"rows": 2, "written": 2, "last_urlkey": "k2", "resume_key": "rk"}')
        payload = state_checkpoint.tar_gz_tree(state_checkpoint._collect(self.root))
        target = os.path.join(self.root, "out2")
        os.makedirs(target)
        manifest = {"schemaVersion": 2, "mediaType": oci.MANIFEST_MEDIA_TYPE,
                    "config": {"digest": "sha256:" + "b" * 64, "size": 1,
                               "mediaType": oci.CONFIG_MEDIA_TYPE},
                    "layers": [{"digest": "sha256:" + "a" * 64,
                                "mediaType": oci.LAYER_MEDIA_TYPE, "size": len(payload)}],
                    "annotations": {"shurik.checkpoint.schema": "1"}}
        out = state_checkpoint.restore_state(target, puller=_FakePuller(manifest, payload))
        self.assertTrue(out["restored"], out)
        self.assertTrue(os.path.exists(os.path.join(target, "data/work/hostdumps/24.media.tumblr.com.jsonl")))
        self.assertTrue(os.path.exists(os.path.join(target, "data/cdx/hostdump-cursors/24.media.tumblr.com.cursor.json")))

    def test_extraction_refuses_paths_outside_the_root(self):
        payload = state_checkpoint.tar_gz_tree([("../escape.json", b"{}")])
        written = state_checkpoint._extract(payload, self.root)
        self.assertEqual(written, [], "a traversal entry must be skipped, not written")
        self.assertFalse(os.path.exists(os.path.join(os.path.dirname(self.root), "escape.json")))


class CheckpointPushTests(unittest.TestCase):
    def test_push_builds_manifest_and_pointer(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = tmp.name
        os.makedirs(os.path.join(root, "data/posts"))
        with open(os.path.join(root, "data/posts/1.json"), "wb") as fh:
            fh.write(b"{}")
        cwd = os.getcwd()
        os.chdir(root)
        self.addCleanup(lambda: os.chdir(cwd))
        registry = _FakeRegistry()
        out = state_checkpoint.push_state(root=root, registry=registry)
        self.assertEqual(out["tag"], "crawl-state")
        self.assertTrue(out["manifest_digest"].startswith("sha256:"))
        self.assertIn("crawl-state", registry.manifests)
        pointer = state_checkpoint.read_pointer()
        self.assertEqual(pointer["manifest_digest"], out["manifest_digest"])
        self.assertEqual(pointer["schema_version"], state_checkpoint.SCHEMA_VERSION)


if __name__ == "__main__":
    unittest.main()
