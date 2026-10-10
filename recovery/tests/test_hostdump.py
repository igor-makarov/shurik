"""Offline tests for the resume-key host inventory (mocked transport)."""
from __future__ import annotations

import base64
import json
import os
import tempfile
import unittest
import zlib

from recovery import config, hostdump
from recovery.http import GAP, OK, Response


def _page(rows, last_key=b"page-two"):
    """A CDX page body: header, captures, then the one-field resume-key row."""
    head = list(hostdump.HEADERS)
    out = [head] + [list(r) for r in rows]
    key = base64.b64encode(zlib.compress(last_key, 9)).decode()
    out.append([key])
    return json.dumps(out)


ROW = ["com,tumblr,media,40)/aaa/tumblr_x500.jpg", "20160125230748",
       "http://40.media.tumblr.com/aaa/tumblr_x500.jpg", "image/jpeg", "200", "D", "100"]


class _FakeFetcher:
    def __init__(self, pages):
        self.pages = pages
        self.queries = []

    def get(self, url):
        self.queries.append(url)
        body = self.pages.pop(0) if self.pages else None
        if body is None:
            return Response(url=url, status=200, body=b"[]", error=OK)
        return Response(url=url, status=200, body=body.encode(), error=OK)


class HostDumpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = os.path.join(self.tmp.name, "dumps")
        self._old = hostdump.DUMP_DIR
        self._old_cursor = hostdump.CURSOR_DIR
        hostdump.DUMP_DIR = self.dir
        hostdump.CURSOR_DIR = os.path.join(self.dir, "cursors")
        self.addCleanup(setattr, hostdump, "DUMP_DIR", self._old)
        self.addCleanup(setattr, hostdump, "CURSOR_DIR", self._old_cursor)

    def test_resume_key_round_trip(self):
        raw = b"com,tumblr,media,78)/zzz/tumblr_y.jpg\t20140101"
        key = base64.b64encode(zlib.compress(raw, 9)).decode()
        self.assertEqual(hostdump.decode_resume_key(key), raw.decode())
        # Wayback sends the key unpadded; decoding must not fail on that alone.
        self.assertEqual(hostdump.decode_resume_key(key.rstrip("=")), raw.decode())
        # A key that is not base64 deflate passes through unchanged: the cursor is
        # opaque and only ever handed back to the server verbatim.
        self.assertEqual(hostdump.decode_resume_key("plain"), "plain")

    def test_parse_page_splits_captures_from_key(self):
        caps, key = hostdump.parse_page(_page([ROW]))
        self.assertEqual(len(caps), 1)
        self.assertEqual(caps[0].timestamp, "20160125230748")
        self.assertNotIn("tumblr_x500", key)

    def test_resume_key_is_kept_verbatim_not_decoded(self):
        raw = b"com,tumblr,media,68)/zzz/tumblr_y.jpg 20140101"
        key = base64.b64encode(zlib.compress(raw, 9)).decode()
        page = json.dumps([list(hostdump.HEADERS), list(ROW), [key]])
        _caps, next_key = hostdump.parse_page(page)
        self.assertEqual(next_key, key,
                         "the opaque key must go back to the server unchanged")
        self.assertNotIn("tumblr_y", next_key)

    def test_parse_page_drops_after_cutoff_rows(self):
        late = list(ROW)
        late[1] = "20200101000000"
        caps, _ = hostdump.parse_page(_page([ROW, late]))
        self.assertEqual([c.timestamp for c in caps], ["20160125230748"])

    def test_scan_resumes_from_cursor_and_persists_every_row(self):
        fetcher = _FakeFetcher([_page([ROW]), _page([ROW], b"")])
        first = hostdump.scan_host(fetcher, "40.media.tumblr.com", max_pages=1)
        self.assertFalse(first["complete"])
        self.assertEqual(first["rows"], 1)
        cur = hostdump.read_cursor("40.media.tumblr.com")
        self.assertTrue(cur["resume_key"])

        # A fresh fetcher must continue from the stored cursor, not page 1: one
        # request, and the unchanged resume key ends the walk.
        fetcher2 = _FakeFetcher([_page([ROW], b"page-two")])
        second = hostdump.scan_host(fetcher2, "40.media.tumblr.com", max_pages=3)
        self.assertIn("resumeKey=", fetcher2.queries[0])
        self.assertEqual(len(fetcher2.queries), 1)
        self.assertTrue(second["complete"])
        self.assertEqual(second["rows"], 2)
        self.assertEqual(hostdump.read_cursor("40.media.tumblr.com")["rows"], 2)

    def test_transient_failure_keeps_the_cursor_for_the_next_pass(self):
        fetcher = _FakeFetcher([_page([ROW])])
        hostdump.scan_host(fetcher, "40.media.tumblr.com", max_pages=1)
        cur = hostdump.read_cursor("40.media.tumblr.com")

        class _Fail(_FakeFetcher):
            def get(self, url):
                return Response(url=url, status=None, error="timeout", message="timed out")

        res = hostdump.scan_host(_Fail([]), "40.media.tumblr.com", max_pages=3)
        self.assertFalse(res["complete"])
        self.assertEqual(hostdump.read_cursor("40.media.tumblr.com"), cur)

    def test_cursor_from_other_filters_is_not_resumed(self):
        _, cur_path = hostdump.dump_paths("40.media.tumblr.com")
        os.makedirs(os.path.dirname(cur_path), exist_ok=True)
        with open(cur_path, "w", encoding="utf-8") as fh:
            json.dump({"host": "40.media.tumblr.com",
                       "scope": {"matchType": "domain", "limit": 2000}, "rows": 9}, fh)
        self.assertEqual(hostdump.read_cursor("40.media.tumblr.com"), {})

    def test_empty_complete_host_is_not_requeried(self):
        # A genuinely empty inventory has no rows to lose; it is still complete.
        hostdump.write_cursor("40.media.tumblr.com", {"complete": True, "rows": 0,
                                                      "written": 0, "pages": 1})
        fetcher = _FakeFetcher([_page([ROW])])
        res = hostdump.scan_host(fetcher, "40.media.tumblr.com")
        self.assertTrue(res["skipped"])
        self.assertEqual(fetcher.queries, [])

    def test_complete_verdict_without_its_rows_is_rewalked(self):
        # The rows the verdict rests on are gone: the claim cannot be checked,
        # so it must not be used as evidence about the host.
        hostdump.write_cursor("40.media.tumblr.com", {"complete": True, "rows": 10,
                                                      "written": 10, "pages": 1})
        fetcher = _FakeFetcher([_page([ROW])])
        res = hostdump.scan_host(fetcher, "40.media.tumblr.com")
        self.assertFalse(res.get("skipped"))
        self.assertTrue(fetcher.queries, "the host must be re-walked when its dump is gone")

    def test_complete_verdict_with_its_rows_is_trusted(self):
        hostdump.write_cursor("40.media.tumblr.com", {"complete": True, "rows": 1,
                                                      "written": 1, "pages": 1})
        dump_path, _ = hostdump.dump_paths("40.media.tumblr.com")
        os.makedirs(os.path.dirname(dump_path), exist_ok=True)
        with open(dump_path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(ROW) + "\n")
        fetcher = _FakeFetcher([_page([ROW])])
        res = hostdump.scan_host(fetcher, "40.media.tumblr.com")
        self.assertTrue(res["skipped"])
        self.assertEqual(fetcher.queries, [])

    def test_partial_cursor_without_its_rows_restarts_from_page_one(self):
        # The fresh-runner state: the cursor rode in data/cdx (supervisor-carried)
        # while its raw rows lived in data/work and are gone. Resuming from the
        # opaque key would skip the missing prefix; the walk must restart.
        hostdump.write_cursor("40.media.tumblr.com", {
            "resume_key": "stale-key", "rows": 5000, "pages": 5, "written": 5000,
            "last_urlkey": "com,tumblr,media,40)/zzz/tumblr_z.jpg", "complete": False})
        fetcher = _FakeFetcher([_page([ROW], b"")])
        res = hostdump.scan_host(fetcher, "40.media.tumblr.com", max_pages=2)
        self.assertNotIn("resumeKey=", fetcher.queries[0],
                         "an unverifiable partial cursor must not be resumed from")
        self.assertEqual(res["rows"], 1, "the restarted walk counts only rows it saw")
        dump_path, _ = hostdump.dump_paths("40.media.tumblr.com")
        self.assertEqual(hostdump._dump_line_count(dump_path), 1)

    def test_partial_cursor_with_matching_rows_resumes(self):
        dump_path, _ = hostdump.dump_paths("40.media.tumblr.com")
        os.makedirs(os.path.dirname(dump_path), exist_ok=True)
        cap = hostdump.parse_page(_page([ROW]))[0][0]
        with open(dump_path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(cap.to_row(), ensure_ascii=False) + "\n")
        hostdump.write_cursor("40.media.tumblr.com", {
            "resume_key": "page-two", "rows": 1, "pages": 1, "written": 1,
            "last_urlkey": cap.urlkey, "complete": False})
        fetcher = _FakeFetcher([_page([ROW], b"page-two")])
        res = hostdump.scan_host(fetcher, "40.media.tumblr.com", max_pages=3)
        self.assertIn("resumeKey=", fetcher.queries[0], "verifiable rows may resume")
        self.assertTrue(res["complete"])

    def test_partial_cursor_with_wrong_tail_identity_restarts(self):
        # The count matches but the last urlkey is not the row the key was minted
        # after: the rows are not the ones the cursor counted, so do not resume.
        dump_path, _ = hostdump.dump_paths("40.media.tumblr.com")
        os.makedirs(os.path.dirname(dump_path), exist_ok=True)
        cap = hostdump.parse_page(_page([ROW]))[0][0]
        with open(dump_path, "w", encoding="utf-8") as fh:
            fh.write(json.dumps(cap.to_row(), ensure_ascii=False) + "\n")
        hostdump.write_cursor("40.media.tumblr.com", {
            "resume_key": "page-two", "rows": 1, "pages": 1, "written": 1,
            "last_urlkey": "com,tumblr,media,40)/other/tumblr_other.jpg", "complete": False})
        fetcher = _FakeFetcher([_page([ROW], b"")])
        hostdump.scan_host(fetcher, "40.media.tumblr.com", max_pages=2)
        self.assertNotIn("resumeKey=", fetcher.queries[0])

    def test_query_carries_the_cutoff_and_collapse(self):
        q = hostdump.build_query("40.media.tumblr.com", "rk")
        self.assertIn(config.CUTOFF, q)
        self.assertIn("collapse=urlkey", q)
        self.assertIn("matchType=domain", q)

    def test_non_media_host_is_refused(self):
        res = hostdump.scan_host(_FakeFetcher([]), "example.com")
        self.assertIn("skipped", res)


if __name__ == "__main__":
    unittest.main()