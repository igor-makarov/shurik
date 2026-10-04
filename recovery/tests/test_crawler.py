"""Failure-case tests for the crawler: cutoffs, gaps, timeouts, bad bodies."""
from __future__ import annotations

import json
import os
import tempfile
import unittest

from recovery import config
from recovery.cdx import CaptureIndex, cdx_query, parse_cdx_json, within_cutoff
from recovery.http import BAD_BODY, GAP, OK, THROTTLED, TIMEOUT, Fetcher, RecoveryError, Response
from recovery.images import image_capture_candidates, resolve_image, sniff_image
from recovery.parsing import (html_to_text, inner_html, is_excluded_image, parse_image_variants,
                              parse_post_page)
from recovery.store import merge_post
from recovery.tests.fixtures import (CAPTION_HEBREW, JPEG_BYTES, NOT_ARCHIVED_HTML, PHOTOSET_HTML,
                                     POST_HTML, FakeArchive, FakeRegistry, binary, cdx_json,
                                     entities, html)


class CutoffTests(unittest.TestCase):
    def test_replay_after_cutoff_is_refused(self):
        with self.assertRaises(RecoveryError):
            Fetcher.replay_url("20200101000000", "http://hazfalafel.com/post/1")

    def test_replay_reports_violation_without_network(self):
        f = FakeArchive({})
        resp = f.replay("20200101000000", "http://hazfalafel.com/post/1")
        self.assertEqual(resp.error, "cutoff_violation")
        self.assertEqual(f.requests, [], "no request may be sent for a post-cutoff capture")

    def test_cdx_drops_rows_after_cutoff(self):
        rows = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
                ["a", "20180101000000", "http://hazfalafel.com/post/1", "text/html", "200", "d", "1"],
                ["b", "20200101000000", "http://hazfalafel.com/post/2", "text/html", "200", "d", "1"]]
        caps = parse_cdx_json(rows)
        self.assertEqual([c.timestamp for c in caps], ["20180101000000"])
        self.assertFalse(within_cutoff("20200101000000"))
        self.assertTrue(within_cutoff("20191231235959"))


class ParsingTests(unittest.TestCase):
    def test_post_record_keeps_hebrew_html_and_text(self):
        rec = parse_post_page(POST_HTML, "http://hazfalafel.com/post/100403945458", "20150119072952",
                              "https://web.archive.org/web/20150119072952id_/x")
        self.assertIn("שלום עולם", rec["content_text"])
        self.assertIn("שורה שנייה", rec["content_text"])
        self.assertIn("שלום", rec["content_html"])
        self.assertEqual(rec["tags"], ["שלום", "Philosoraptor"])
        self.assertIn("Posted on Tuesday", rec["posted_on"])
        self.assertEqual(rec["post_id"], "100403945458")

    def test_only_post_images_are_kept(self):
        rec = parse_post_page(POST_HTML, "http://hazfalafel.com/post/100403945458", "20150119072952")
        urls = [i["media_url"] for i in rec["images"]]
        self.assertEqual(len(urls), 1, urls)
        self.assertIn("tumblr_ndozw9K7Dz1r3it8zo1", urls[0])
        for bad in ("avatar", "impixu", "fb_share", "default_avatar"):
            self.assertNotIn(bad, " ".join(urls))

    def test_caption_comes_from_alt_without_invention(self):
        # Archived HTML stores Hebrew in logical order; recovery must reproduce
        # the captured characters exactly and never reorder or "correct" them.
        rec = parse_post_page(POST_HTML, "http://hazfalafel.com/post/100403945458", "20150119072952")
        self.assertEqual(rec["captions"], [CAPTION_HEBREW])
        self.assertEqual(rec["images"][0]["caption_alt"], CAPTION_HEBREW)

    def test_entity_encoded_hebrew_round_trips(self):
        rec = parse_post_page(POST_HTML, "http://hazfalafel.com/post/100403945458", "20150119072952")
        self.assertIn("&#", POST_HTML, "fixture must exercise numeric character references")
        self.assertEqual(rec["captions"][0], CAPTION_HEBREW)
        self.assertEqual(entities(CAPTION_HEBREW), entities(rec["captions"][0]))

    def test_photoset_page_yields_every_photo(self):
        rec = parse_post_page(PHOTOSET_HTML, "http://hazfalafel.com/post/104317036098/photoset_iframe/x/500/false",
                              "20141220184301")
        self.assertEqual(len(rec["images"]), 2)
        self.assertEqual(rec["images"][1]["caption_alt"], "תמונה שנייה")

    def test_exclusion_reasons_are_explicit(self):
        self.assertEqual(is_excluded_image("http://33.media.tumblr.com/avatar_x_16.png"), "avatar")
        self.assertIn("impixu", is_excluded_image("https://px.srvcs.tumblr.com/impixu?T=1"))
        self.assertIsNone(is_excluded_image("http://40.media.tumblr.com/aa/tumblr_b_500.jpg"))

    def test_balanced_inner_html(self):
        doc = "<div class='copy'>a<div>b</div>c</div><div class='tags'>t</div>"
        self.assertEqual(inner_html(doc, "div", "copy")[0], "a<div>b</div>c")

    def test_html_to_text_drops_scripts(self):
        self.assertNotIn("alert", html_to_text("<p>ok</p><script>alert(1)</script>"))


class ImageRecoveryTests(unittest.TestCase):
    def _routes(self, cdx_rows, replay: Response):
        return {"cdx/search/cdx": Response(url="", status=200, body=cdx_json(cdx_rows),
                                            headers={"content-type": "application/json"}, error=OK),
                "/web/20150119072952id_/http://40.media.tumblr.com": replay}

    IMAGE_URL = "http://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/tumblr_ndozw9K7Dz1r3it8zo1_500.jpg"

    def test_recovered_image_is_stored_and_recorded(self):
        rows = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
                ["k", "20150119072952", self.IMAGE_URL, "image/jpeg", "200", "ABC", "100"]]
        f = FakeArchive(self._routes(rows, binary(JPEG_BYTES)))
        rec = resolve_image(f, {"media_url": self.IMAGE_URL, "caption_alt": "מה זה"}, max_captures=1)
        self.assertEqual(rec["state"], "recovered")
        self.assertEqual(rec["media_type"], "image/jpeg")
        self.assertEqual(rec["capture"]["timestamp"], "20150119072952")
        self.assertTrue(any(a.get("endpoint") == "replay id_" for a in rec["attempts"]))

    def test_html_error_page_is_not_accepted_as_image(self):
        rows = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
                ["k", "20150119072952", self.IMAGE_URL, "text/html", "200", "ABC", "100"]]
        f = FakeArchive(self._routes(rows, html(NOT_ARCHIVED_HTML)))
        rec = resolve_image(f, {"media_url": self.IMAGE_URL, "caption_alt": ""}, max_captures=1)
        self.assertEqual(rec["state"], "missing")
        self.assertEqual(rec["error"], BAD_BODY)
        self.assertIsNone(rec["sha256"])

    def test_confirmed_gap_when_no_capture_exists(self):
        rows = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"]]
        f = FakeArchive(self._routes(rows, binary(JPEG_BYTES)))
        rec = resolve_image(f, {"media_url": self.IMAGE_URL}, max_captures=1)
        self.assertEqual(rec["state"], "missing")
        self.assertEqual(rec["error"], GAP)
        self.assertIn("variants", rec["attempts"][0])

    def test_timeout_is_retried_then_reported_as_timeout(self):
        rows = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
                ["k", "20150119072952", self.IMAGE_URL, "image/jpeg", "200", "ABC", "100"]]
        routes = self._routes(rows, Response(url="", status=None, error=TIMEOUT, message="read timeout"))
        f = FakeArchive(routes, attempts=3)
        rec = resolve_image(f, {"media_url": self.IMAGE_URL}, max_captures=1)
        self.assertEqual(rec["error"], TIMEOUT)
        self.assertNotEqual(rec["error"], GAP, "a timeout must not be recorded as an archive gap")
        retries = [u for u in f.requests if "/web/" in u]
        self.assertGreaterEqual(len(retries), 3, "transient failures must be retried")

    def test_throttling_is_retried_and_not_a_gap(self):
        rows = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
                ["k", "20150119072952", self.IMAGE_URL, "image/jpeg", "200", "ABC", "100"]]
        routes = self._routes(rows, Response(url="", status=503, error=THROTTLED, message="slow down"))
        f = FakeArchive(routes, attempts=2)
        rec = resolve_image(f, {"media_url": self.IMAGE_URL}, max_captures=1)
        self.assertEqual(rec["error"], THROTTLED)

    def test_sniff_rejects_short_and_html_bodies(self):
        self.assertIsNone(sniff_image(b""))
        self.assertIsNone(sniff_image(b"<html>not an image</html>" * 5))
        self.assertEqual(sniff_image(JPEG_BYTES), "image/jpeg")


class MergeTests(unittest.TestCase):
    def test_recovered_image_is_never_downgraded(self):
        old = {"post_id": "1", "images": [{"media_url": "u", "sha256": "abc", "state": "recovered",
                                           "blob_path": "/tmp/abc", "media_type": "image/jpeg",
                                           "attempts": [{"ok": True}]}],
               "content_text": "שלום", "tags": ["שלום"], "captions": ["שלום"]}
        new = {"post_id": "1", "images": [{"media_url": "u", "state": "missing", "error": "timeout",
                                           "attempts": [{"ok": False}]}], "tags": []}
        merged = merge_post(old, new)
        self.assertEqual(merged["images"][0]["sha256"], "abc")
        self.assertEqual(merged["missing_image_count"], 0)
        self.assertEqual(merged["tags"], ["שלום"])
        self.assertEqual(merged["content_text"], "שלום")

    def test_partial_post_is_marked_partial(self):
        merged = merge_post({}, {"post_id": "2", "images": [
            {"media_url": "a", "sha256": "x", "blob_path": "p", "media_type": "image/jpeg"},
            {"media_url": "b", "state": "missing", "error": GAP}], "content_text": "t"})
        self.assertEqual(merged["state"], "partial")
        self.assertEqual(merged["image_count"], 1)
        self.assertEqual(merged["missing_image_count"], 1)
        self.assertEqual(merged["missing_images"][0]["media_url"], "b")

    def test_richer_content_wins(self):
        merged = merge_post({"content_html": "<p>a</p>"}, {"content_html": "<p>a</p><p>bb</p>"})
        self.assertEqual(merged["content_html"], "<p>a</p><p>bb</p>")


class VariantPlanningTests(unittest.TestCase):
    """Size/extension siblings are real recovery leads, not decoration."""

    _helper = ImageRecoveryTests("run")

    def test_variants_are_generated_for_hashed_and_bare_paths(self):
        for url in ("http://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/"
                    "tumblr_ndozw9K7Dz1r3it8zo1_500.jpg",
                    "http://25.media.tumblr.com/tumblr_lv9rkd6wmw1r3it8zo1_500.jpg",
                    "http://24.media.tumblr.com/9jqgd8kolmtl9l7jkn5881q9o1_250.jpg"):
            variants = parse_image_variants(url)
            self.assertEqual(variants[0], url, "the linked URL itself must be tried first")
            self.assertTrue(any(v.endswith("_540.jpg") for v in variants), url)
            self.assertTrue(any(v.endswith("_1280.jpg") for v in variants), url)
            for v in variants:
                self.assertTrue(v.startswith("http"), f"{v} lost its host/dir prefix")
                self.assertIn(url.rsplit("/", 1)[0], v)

    def test_exact_url_is_queried_before_siblings(self):
        rows = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
                ["k", "20150119072952", ImageRecoveryTests.IMAGE_URL, "image/jpeg", "200", "ABC", "100"]]
        f = FakeArchive(self._helper._routes(rows, binary(JPEG_BYTES)))
        captures, attempts = image_capture_candidates(f, ImageRecoveryTests.IMAGE_URL)
        queried = [a["url"] for a in attempts if a.get("endpoint") == "cdx"]
        self.assertEqual(queried[0], ImageRecoveryTests.IMAGE_URL)
        self.assertEqual(len(queried), 1, "a hit on the exact URL must not fan out into siblings")
        self.assertEqual(len(captures), 1)

    def test_sibling_variants_are_tried_when_the_exact_url_has_nothing(self):
        empty = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"]]
        routes = {"cdx/search/cdx": Response(url="", status=200, body=cdx_json(empty),
                                             headers={"content-type": "application/json"}, error=OK)}
        f = FakeArchive(routes)
        captures, attempts = image_capture_candidates(f, ImageRecoveryTests.IMAGE_URL, variant_budget=3)
        self.assertEqual(captures, [])
        queried = [a["url"] for a in attempts if a.get("endpoint") == "cdx"]
        self.assertEqual(queried[0], ImageRecoveryTests.IMAGE_URL)
        self.assertEqual(len(queried), 4, "budget of 3 siblings on top of the exact URL")
        self.assertTrue(any(a.get("endpoint") == "variant-budget" for a in attempts),
                        "budgeted-away siblings must still be recorded")


if __name__ == "__main__":
    unittest.main()


class PublishSelectionTests(unittest.TestCase):
    """Progressive publishing: text now, images when they are recovered."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self._saved = {k: getattr(config, k) for k in
                       ("DATA_DIR", "POST_DIR", "PUBLISHED_JSONL", "BLOB_DIR")}
        config.DATA_DIR = self._tmp.name
        config.POST_DIR = os.path.join(self._tmp.name, "posts")
        config.PUBLISHED_JSONL = os.path.join(self._tmp.name, "published.jsonl")
        config.BLOB_DIR = os.path.join(self._tmp.name, "blobs")
        self.addCleanup(self._restore)

    def _restore(self):
        for k, v in self._saved.items():
            setattr(config, k, v)

    def _post(self, pid: str = "100403945458", **kw) -> dict:
        rec = {"post_id": pid, "content_text": "שלום", "captions": ["שלום"], "tags": ["שלום"],
               "original_url": f"http://hazfalafel.com/post/{pid}",
               "capture": {"timestamp": "20150119072952"}, "images": []}
        rec.update(kw)
        return rec

    def _run(self, registry=None):
        from recovery import cli

        return cli.publish(limit=50, registry=registry or FakeRegistry(), fetcher=FakeArchive({}))

    def test_text_only_post_is_published_as_partial(self):
        from recovery import oci
        from recovery.store import PostStore

        store = PostStore(config.POST_DIR)
        store.put("100403945458", self._post(images=[
            {"media_url": "http://40.media.tumblr.com/x/tumblr_a_500.jpg", "state": "missing",
             "error": GAP, "attempts": [{"endpoint": "cdx", "captures": 0}]}]))
        out = self._run()
        self.assertEqual(out["processed"], 1, "a post with recovered text must publish")
        self.assertEqual(out["results"][0]["action"], "pushed")
        self.assertEqual(out["results"][0]["image_count"], 0)
        self.assertEqual(out["results"][0]["missing_count"], 1)
        rec = store.get("100403945458")
        self.assertTrue(rec["published"]["quality"], "publish quality is recorded for reruns")
        # The artifact itself must admit that the image is missing.
        config_blob, layers, tag, manifest, _ = oci.build_artifact(rec)
        import json as _json
        doc = _json.loads(config_blob.data.decode("utf-8"))
        self.assertTrue(doc["shurik"]["post"]["recovery"]["partial"])
        self.assertEqual(tag, "100403945458")
        self.assertEqual(manifest["annotations"]["shurik.post.missing_images"], "1")
        self.assertEqual(manifest["annotations"]["org.opencontainers.image.source"],
                         config.REPO_SOURCE_LABEL)
        self.assertIn("שלום", _json.dumps(doc, ensure_ascii=False))

    def test_rerun_skips_published_post_and_never_regresses(self):
        from recovery import cli
        from recovery.store import PostStore

        store = PostStore(config.POST_DIR)
        store.put("1", self._post(pid="1"))
        self._run()
        self.assertEqual(self._run()["processed"], 0, "an unchanged post must not be republished")
        # Simulate a worse local record (e.g. a re-parse that lost the text):
        # the publish loop must refuse to replace richer published metadata.
        rec = store.get("1")
        rec["content_text"] = ""
        store.put("1", rec)
        self.assertEqual(self._run()["processed"], 0)

    def test_registry_skip_when_published_artifact_has_more_data(self):
        from recovery.publish import publish_post

        reg = FakeRegistry(manifests={"100403945458": {
            "annotations": {"shurik.post.images": "2", "shurik.post.content_len": "50",
                            "shurik.post.cutoff": config.CUTOFF}}})
        res = publish_post(self._post(), reg)
        self.assertEqual(res.action, "skipped")
        self.assertEqual(reg.pushes, [], "nothing may be pushed over a richer artifact")

    def test_registry_republishes_when_more_text_is_recovered(self):
        from recovery.publish import publish_post

        reg = FakeRegistry(manifests={"100403945458": {
            "annotations": {"shurik.post.images": "0", "shurik.post.content_len": "2",
                            "shurik.post.cutoff": config.CUTOFF}}})
        res = publish_post(self._post(), reg)
        self.assertEqual(res.action, "updated")
        self.assertEqual(len(reg.pushes), 1)


class RegistryPlumbingTests(unittest.TestCase):
    """The GHCR wire protocol, exercised without a network."""

    def _registry(self, session):
        from recovery.publish import Registry

        reg = Registry()
        reg.session = session
        reg.sleep = lambda *_: None
        return reg

    def test_blob_upload_uses_octet_stream_and_digest(self):
        from recovery import oci
        from recovery.tests.fixtures import FakeRegistrySession

        session = FakeRegistrySession()
        blob = oci.Blob(b"payload", "application/vnd.oci.image.config.v1+json")
        self._registry(session).push_blob(blob)
        put = [c for c in session.calls if c[0] == "PUT"][0]
        self.assertEqual(put[2]["Content-Type"], "application/octet-stream")
        self.assertIn(f"digest={blob.digest}", put[1])
        self.assertEqual(session.blob_bodies[blob.digest], b"payload")

    def test_non_octet_stream_upload_failure_is_reported_with_registry_error(self):
        from recovery import oci
        from recovery.publish import PublishError
        from recovery.tests.fixtures import FakeRegistrySession

        class Strict(oci.Blob):
            media_type = "application/vnd.oci.image.layer.v1.tar+gzip"

        session = FakeRegistrySession()
        reg = self._registry(session)
        # Force the real failure mode: a client that sends its own media type.
        orig_request = reg._request

        def bad_request(method, url, headers=None, data=None, retries=3, timeout=180):
            if method == "PUT" and "/blobs/upload/" in url:
                return session.request(method, url, headers={**dict(headers or {}),
                                                            "Content-Type": Strict.media_type},
                                       data=data)
            return orig_request(method, url, headers=headers, data=data, retries=retries, timeout=timeout)

        reg._request = bad_request
        with self.assertRaises(PublishError) as ctx:
            reg.push_blob(oci.Blob(b"payload", Strict.media_type))
        self.assertIn("invalid content-type", str(ctx.exception))

    def test_expired_token_is_refreshed_and_the_upload_retried(self):
        from recovery import oci
        from recovery.tests.fixtures import FakeRegistrySession

        session = FakeRegistrySession(unauthorized_once=True)
        reg = self._registry(session)
        blob = oci.Blob(b"payload", "application/octet-stream")
        reg.push_blob(blob)
        self.assertEqual(session.blob_bodies[blob.digest], b"payload")
        self.assertGreaterEqual(len([c for c in session.calls if c[0] == "GET" and "/token" in c[1]]), 2)
