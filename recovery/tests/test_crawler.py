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
from recovery.media import MediaIndex
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
        rec = resolve_image(f, {"media_url": self.IMAGE_URL, "caption_alt": "מה זה"}, max_captures=1,
                            method="cdx")
        self.assertEqual(rec["state"], "recovered")
        self.assertEqual(rec["media_type"], "image/jpeg")
        self.assertEqual(rec["capture"]["timestamp"], "20150119072952")
        self.assertTrue(any(a.get("endpoint") == "replay id_" for a in rec["attempts"]))

    def test_html_error_page_is_not_accepted_as_image(self):
        rows = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
                ["k", "20150119072952", self.IMAGE_URL, "text/html", "200", "ABC", "100"]]
        f = FakeArchive(self._routes(rows, html(NOT_ARCHIVED_HTML)))
        rec = resolve_image(f, {"media_url": self.IMAGE_URL, "caption_alt": ""}, max_captures=1,
                            method="cdx")
        self.assertEqual(rec["state"], "missing")
        self.assertEqual(rec["error"], BAD_BODY)
        self.assertIsNone(rec["sha256"])

    def test_confirmed_gap_when_no_capture_exists(self):
        rows = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"]]
        f = FakeArchive(self._routes(rows, binary(JPEG_BYTES)))
        rec = resolve_image(f, {"media_url": self.IMAGE_URL}, max_captures=1, method="cdx")
        self.assertEqual(rec["state"], "missing")
        self.assertEqual(rec["error"], GAP)
        self.assertIn("variants", rec["attempts"][0])

    def test_timeout_is_retried_then_reported_as_timeout(self):
        rows = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
                ["k", "20150119072952", self.IMAGE_URL, "image/jpeg", "200", "ABC", "100"]]
        routes = self._routes(rows, Response(url="", status=None, error=TIMEOUT, message="read timeout"))
        f = FakeArchive(routes, attempts=3)
        rec = resolve_image(f, {"media_url": self.IMAGE_URL}, max_captures=1, method="cdx")
        self.assertEqual(rec["error"], TIMEOUT)
        self.assertNotEqual(rec["error"], GAP, "a timeout must not be recorded as an archive gap")
        retries = [u for u in f.requests if "/web/" in u]
        self.assertGreaterEqual(len(retries), 3, "transient failures must be retried")

    def test_throttling_is_retried_and_not_a_gap(self):
        rows = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
                ["k", "20150119072952", self.IMAGE_URL, "image/jpeg", "200", "ABC", "100"]]
        routes = self._routes(rows, Response(url="", status=503, error=THROTTLED, message="slow down"))
        f = FakeArchive(routes, attempts=2)
        rec = resolve_image(f, {"media_url": self.IMAGE_URL}, max_captures=1, method="cdx")
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

    def test_media_index_answers_without_any_cdx_query(self):
        """A host inventory in Git must replace per-image CDX queries.

        The archive stores the same media file under a *different* CDN host and
        with a hash directory (observed: 25/40.media.tumblr.com hold
        `<hash>/tumblr_xxx_1280.jpg` while the post page links a bare
        `_500.jpg`). Keying the inventory by media file rather than full URL is
        what lets those be found at all, and answering locally avoids the ~22 s
        per-query cost that throttles the crawl.
        """
        link = "http://78.media.tumblr.com/tumblr_m90i69qEHH1r3it8zo1_500.jpg"
        archived = ("http://25.media.tumblr.com/0000060e2bc8f4709c4bf6e7f233f7c1/"
                    "tumblr_m90i69qEHH1r3it8zo1_1280.jpg")
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "media.jsonl")
            index = MediaIndex(path)
            index.add(parse_cdx_json([["urlkey", "timestamp", "original", "mimetype",
                                       "statuscode", "digest", "length"],
                                      ["k", "20180101000000", archived, "image/jpeg",
                                       "200", "ABC", "100"]], source_query="host:25"))
            # Reload from disk: the inventory has to survive to the next runner.
            reloaded = MediaIndex(path)
            self.assertEqual(len(reloaded.lookup(link)), 1)
            self.assertEqual(reloaded.lookup(link)[0].original, archived)

            # Resolving the image must now hit the archive once (the replay) and
            # must not issue a single CDX query.
            routes = {"web/20180101000000id_": Response(
                url="", status=200, body=JPEG_BYTES,
                headers={"content-type": "image/jpeg"}, error=OK)}
            f = FakeArchive(routes)
            rec = resolve_image(f, {"media_url": link, "caption_alt": "תמונה",
                                    "found_in": "img"}, media_index=reloaded)
            self.assertEqual(rec["state"], "recovered", rec.get("note"))
            self.assertEqual(rec["capture"]["original"], archived)
            self.assertFalse([a for a in rec["attempts"] if a.get("endpoint") == "cdx"],
                             "the media inventory must suppress per-variant CDX queries")

    def test_media_index_ignores_post_cutoff_captures(self):
        link = "http://78.media.tumblr.com/tumblr_m90i69qEHH1r3it8zo1_500.jpg"
        after = ("http://25.media.tumblr.com/0000060e2bc8f4709c4bf6e7f233f7c1/"
                 "tumblr_m90i69qEHH1r3it8zo1_1280.jpg")
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "media.jsonl")
            index = MediaIndex(path)
            index.add(parse_cdx_json([["urlkey", "timestamp", "original", "mimetype",
                                       "statuscode", "digest", "length"],
                                      ["k", "20210101000000", after, "image/jpeg",
                                       "200", "ABC", "100"]], source_query="host:25"))
            routes = {"web/20210101000000id_": Response(
                url="", status=200, body=JPEG_BYTES,
                headers={"content-type": "image/jpeg"}, error=OK)}
            rec = resolve_image(FakeArchive(routes),
                                {"media_url": link, "found_in": "img"},
                                media_index=MediaIndex(path))
            self.assertNotEqual(rec["state"], "recovered",
                                "a post-cutoff capture must never be used")


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


class HostInventoryEvidenceTests(unittest.TestCase):
    """A complete host inventory is positive evidence, not an assumption.

    Scanning a whole `*.media.tumblr.com` host costs one paginated CDX query
    and enumerates every pre-cutoff 200 capture of that host. When such a scan
    is complete *and* was taken after the media key was already known, "this
    key has no capture" is a confirmed archive gap and no per-variant query
    should be spent re-asking the archive.
    """

    LINK = "http://78.media.tumblr.com/e93d04f7/tumblr_mqrhwt1Ui21r3it8zo5_1280.jpg"

    def _index(self, tmp, scanned_at, rows=1):
        path = os.path.join(tmp, "media.jsonl")
        index = MediaIndex(path)
        index.add(parse_cdx_json(
            [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
             ["k", "20150101000000", "http://78.media.tumblr.com/other/tumblr_zz_500.jpg",
              "image/jpeg", "200", "ABC", "100"]] * rows, source_query="host:78"))
        index.mark_host("78.media.tumblr.com", {"host": "78.media.tumblr.com", "rows": 2642,
                                                "pages": 1, "complete": True,
                                                "scanned_at": scanned_at, "keys_at_scan": 10})
        return MediaIndex(path)

    def test_complete_scan_confirms_gap_without_any_cdx_query(self):
        with tempfile.TemporaryDirectory() as tmp:
            index = self._index(tmp, "2026-10-05T00:10:00+00:00")
            f = FakeArchive({})  # every CDX/replay request would 404: none allowed
            rec = resolve_image(f, {"media_url": self.LINK, "found_in": "img"},
                                media_index=index, key_known_at="2026-10-04T23:00:00+00:00")
            self.assertEqual(rec["state"], "missing")
            self.assertEqual(rec["error"], GAP)
            self.assertEqual(rec["host_inventory"]["rows"], 2642)
            self.assertEqual(f.requests, [], "a conclusive host scan must cost no archive request")

    def test_scan_predating_the_key_is_not_conclusive(self):
        """The dump's key filter did not include this key yet: keep asking."""
        with tempfile.TemporaryDirectory() as tmp:
            index = self._index(tmp, "2026-10-01T00:00:00+00:00")
            routes = {"/cdx/search/cdx": Response(url="", status=200, body=b"[]", error=OK)}
            rec = resolve_image(FakeArchive(routes),
                                {"media_url": self.LINK, "found_in": "img"},
                                media_index=index, key_known_at="2026-10-04T23:00:00+00:00",
                                method="cdx")
            self.assertTrue([a for a in rec["attempts"] if a.get("endpoint") == "cdx"],
                            "a stale host scan must fall back to per-variant CDX queries")
            self.assertEqual(rec["state"], "missing")

    def test_incomplete_scan_never_claims_a_gap(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "media.jsonl")
            index = MediaIndex(path)
            index.mark_host("78.media.tumblr.com", {"host": "78.media.tumblr.com", "rows": 5000,
                                                    "pages": 1, "complete": False,
                                                    "scanned_at": "2026-10-05T00:10:00+00:00"})
            routes = {"/cdx/search/cdx": Response(url="", status=200, body=b"[]", error=OK)}
            rec = resolve_image(FakeArchive(routes), {"media_url": self.LINK},
                                media_index=MediaIndex(path),
                                key_known_at="2026-10-04T23:00:00+00:00")
            self.assertEqual(rec["state"], "missing")
            self.assertIsNone(rec.get("host_inventory"),
                              "an interrupted scan is not evidence of absence")


class PostFailureBookkeepingTests(unittest.TestCase):
    """Failed posts must leave the queue, otherwise nothing else is crawled."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self._saved = {k: getattr(config, k) for k in ("DATA_DIR", "POST_DIR", "CDX_DIR",
                                                       "MISSING_JSONL")}
        config.DATA_DIR = self._tmp.name
        config.POST_DIR = os.path.join(self._tmp.name, "posts")
        config.CDX_DIR = os.path.join(self._tmp.name, "cdx")
        config.MISSING_JSONL = os.path.join(self._tmp.name, "missing.jsonl")
        self.addCleanup(self._restore)
        from recovery import cli
        self.cli = cli
        # One inventoried permalink capture for post 13397484447.
        self.cli.POST_CAPTURE_FILE = os.path.join(config.CDX_DIR, "posts.jsonl")
        CaptureIndex(self.cli.POST_CAPTURE_FILE).add(parse_cdx_json(
            [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
             ["com,hazfalafel)/post/13397484447", "20120426030759",
              "http://hazfalafel.com:80/post/13397484447", "text/html", "200", "A", "1"]],
            source_query="hazfalafel.com/post/*"))

    def _restore(self):
        for k, v in self._saved.items():
            setattr(config, k, v)

    def test_permanent_failure_is_stored_and_not_retried_forever(self):
        from recovery.store import PostStore
        routes = {"/web/20120426030759id_": Response(url="", status=404,
                                                     body=NOT_ARCHIVED_HTML.encode(), error=GAP),
                  "wayback/available": Response(
                      url="", status=200,
                      body=json.dumps({"archived_snapshots": {"closest": {
                          "timestamp": "20120426030759", "status": "200"}}}).encode(), error=OK)}
        f = FakeArchive(routes)
        out = self.cli.fetch_posts(f, limit=5, concurrency=1)
        self.assertEqual(out["processed"], 1)
        rec = PostStore(config.POST_DIR).get("13397484447")
        self.assertEqual(rec["state"], "failed")
        self.assertEqual(rec["captures"][0]["timestamp"], "20120426030759")
        self.assertEqual(rec["failure_count"], 1)
        # Second pass: the stored capture counts as attempted, so no work is done.
        again = self.cli.fetch_posts(f, limit=5, concurrency=1)
        self.assertEqual(again["processed"], 0, again)
        self.assertEqual(len(f.requests), len(routes) + len(routes) - len(routes), )

    def test_transient_failure_is_retried_within_the_budget(self):
        from recovery.store import PostStore
        store = PostStore(config.POST_DIR)
        store.put("13397484447", {
            "post_id": "13397484447", "state": "failed", "failure_count": 1,
            "captures": [{"timestamp": "20120426030759",
                          "original": "http://hazfalafel.com:80/post/13397484447"}],
            "methods": [{"endpoint": "replay id_", "error": TIMEOUT}]})
        routes = {"/web/20120426030759id_": Response(url="", status=200,
                                                     body=POST_HTML.encode(), error=OK)}
        out = self.cli.fetch_posts(FakeArchive(routes), limit=5, concurrency=1)
        self.assertEqual(out["processed"], 1, "a timeout must be retried")
        rec = store.get("13397484447")
        self.assertTrue(rec.get("content_text"), "the retry recovered the post")

    def test_exhausted_failure_budget_stops_the_post(self):
        from recovery.store import PostStore
        store = PostStore(config.POST_DIR)
        store.put("13397484447", {
            "post_id": "13397484447", "state": "failed",
            "failure_count": self.cli.MAX_FAILURES,
            "captures": [{"timestamp": "20120426030759",
                          "original": "http://hazfalafel.com:80/post/13397484447"}],
            "methods": [{"endpoint": "replay id_", "error": GAP}]})
        out = self.cli.fetch_posts(FakeArchive({}), limit=5, concurrency=1)
        self.assertEqual(out["processed"], 0, "permanent gap, budget spent: move on")


class ReplayProbeTests(unittest.TestCase):
    """The replay-probe path: one bounded request decides image existence.

    Real evidence this exists and is worth its own path: post 100416769893's
    image `40.media.tumblr.com/adb87bdd.../tumblr_ndp94n8cUf1r3it8zo1_500.jpg`
    answers `302 -> /web/20150106090204im_/...` (pre-cutoff) while its
    neighbours answer 404. One request tells the two apart, where a CDX query
    took tens of seconds per image.
    """

    IMAGE_URL = ("http://40.media.tumblr.com/adb87bddbbc96c60f41476a0ba60a36d/"
                 "tumblr_ndp94n8cUf1r3it8zo1_500.jpg")

    def redirect(self, capture_ts: str) -> Response:
        return Response(url="", status=302, body=b"",
                        headers={"location": f"https://web.archive.org/web/{capture_ts}im_/"
                                             f"{self.IMAGE_URL}"}, error=OK)

    def routes(self, probe: Response, replay: Response) -> dict:
        return {"im_/http://40.media.tumblr.com": probe,
                "id_/http://40.media.tumblr.com": replay}

    def test_probe_recovers_image_and_records_capture(self):
        f = FakeArchive(self.routes(self.redirect("20150106090204"), binary(JPEG_BYTES)))
        rec = resolve_image(f, {"media_url": self.IMAGE_URL, "caption_alt": "תמונה"},
                            method="probe", max_captures=1)
        self.assertEqual(rec["state"], "recovered")
        self.assertEqual(rec["capture"]["timestamp"], "20150106090204")
        self.assertEqual(rec["media_type"], "image/jpeg")
        probe_attempts = [a for a in rec["attempts"] if a.get("endpoint") == "replay-probe"]
        self.assertEqual(len(probe_attempts), 1, "a hit on the exact URL must not fan out")
        self.assertEqual(probe_attempts[0]["capture_timestamp"], "20150106090204")

    def test_probe_404_on_every_variant_is_a_confirmed_gap(self):
        routes = {"im_/": Response(url="", status=404, body=b"", error=GAP,
                                   message="has not been archived")}
        f = FakeArchive(routes)
        rec = resolve_image(f, {"media_url": self.IMAGE_URL}, method="probe", variant_budget=3)
        self.assertEqual(rec["state"], "missing")
        self.assertEqual(rec["error"], GAP)
        probes = [a for a in rec["attempts"] if a.get("endpoint") == "replay-probe"]
        self.assertEqual(len(probes), 4, "exact URL plus the 3 budgeted siblings")
        self.assertEqual(probes[0]["url"], self.IMAGE_URL)
        self.assertTrue(any(a.get("endpoint") == "variant-budget" for a in rec["attempts"]))

    def test_sibling_variant_hit_is_used_and_labelled(self):
        def probe(url, timeout):
            if url is None:
                return Response(url="", status=404, error=GAP)
            if "_1280.jpg" in url:
                return Response(url="", status=302,
                                headers={"location": f"https://web.archive.org/web/20160201120000im_/{url}"},
                                error=OK)
            return Response(url="", status=404, error=GAP)

        class ProbeArchive(FakeArchive):
            def _get_noredirect(self, url, timeout):
                self.requests.append(url)
                return probe(url, timeout)

        f = ProbeArchive({"/web/20160201120000id_/": binary(JPEG_BYTES)})
        rec = resolve_image(f, {"media_url": self.IMAGE_URL}, method="probe", variant_budget=4,
                            max_captures=1)
        self.assertEqual(rec["state"], "recovered")
        self.assertTrue(rec["capture"]["original"].endswith("_1280.jpg"),
                        "the recovered capture must name the variant that exists")
        self.assertEqual(rec["capture"]["timestamp"], "20160201120000")

    def test_post_cutoff_only_capture_is_refused_and_never_downloaded(self):
        f = FakeArchive({"im_/": self.redirect("20210304000000"), "id_/": binary(JPEG_BYTES)})
        rec = resolve_image(f, {"media_url": self.IMAGE_URL}, method="probe", backsteps=1,
                            variant_budget=0)
        self.assertEqual(rec["state"], "missing")
        self.assertEqual(rec["error"], "capture_after_cutoff")
        self.assertIsNone(rec["sha256"])
        self.assertFalse([u for u in f.requests if "id_/" in u],
                         "no bytes may be fetched from a post-cutoff capture")

    def test_probe_step_back_finds_an_earlier_capture(self):
        seq = [Response(url="", status=302,
                        headers={"location": f"https://web.archive.org/web/20210304000000im_/{self.IMAGE_URL}"},
                        error=OK),
               Response(url="", status=302,
                        headers={"location": f"https://web.archive.org/web/20160101000000im_/{self.IMAGE_URL}"},
                        error=OK)]
        class Seq(FakeArchive):
            def _get_noredirect(self, url, timeout):
                self.requests.append(url)
                return seq.pop(0)

        f = Seq({"id_/": binary(JPEG_BYTES)})
        rec = resolve_image(f, {"media_url": self.IMAGE_URL}, method="probe", variant_budget=0,
                            max_captures=1)
        self.assertEqual(rec["state"], "recovered")
        self.assertEqual(rec["capture"]["timestamp"], "20160101000000")

    def test_transient_probe_is_not_a_gap_and_auto_falls_back_to_cdx(self):
        rows = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"],
                ["k", "20150106090204", self.IMAGE_URL, "image/jpeg", "200", "ABC", "100"]]
        routes = {"im_/": Response(url="", status=None, error=TIMEOUT, message="read timeout"),
                  "cdx/search/cdx": Response(url="", status=200, body=cdx_json(rows),
                                             headers={"content-type": "application/json"}, error=OK),
                  "id_/": binary(JPEG_BYTES)}
        f = FakeArchive(routes, attempts=2)
        rec = resolve_image(f, {"media_url": self.IMAGE_URL}, method="auto", max_captures=1)
        self.assertEqual(rec["state"], "recovered", "auto must fall back to the CDX after a timeout")
        self.assertTrue(any(a.get("endpoint") == "cdx" for a in rec["attempts"]))

    def test_probe_timeout_alone_is_reported_as_timeout_not_gap(self):
        f = FakeArchive({"im_/": Response(url="", status=None, error=TIMEOUT, message="t")},
                        attempts=2)
        rec = resolve_image(f, {"media_url": self.IMAGE_URL}, method="probe", variant_budget=0)
        self.assertEqual(rec["error"], TIMEOUT)
        self.assertNotEqual(rec["error"], GAP)

    def test_attempt_log_is_bounded_but_says_how_much_was_folded(self):
        routes = {"im_/": Response(url="", status=404, error=GAP)}
        f = FakeArchive(routes)
        rec = resolve_image(f, {"media_url": self.IMAGE_URL}, method="probe", variant_budget=9)
        self.assertLessEqual(len(rec["attempts"]), 12)
        summary = [a for a in rec["attempts"] if a.get("endpoint") == "attempt-log"]
        self.assertTrue(summary and summary[0]["n_earlier_attempts"] > 0)

    def test_probe_404_does_not_issue_a_cdx_query(self):
        empty = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"]]
        routes = {"im_/": Response(url="", status=404, error=GAP),
                  "cdx/search/cdx": Response(url="", status=200, body=cdx_json(empty),
                                             headers={"content-type": "application/json"}, error=OK)}
        f = FakeArchive(routes)
        resolve_image(f, {"media_url": self.IMAGE_URL}, method="probe", variant_budget=1)
        self.assertFalse([u for u in f.requests if "cdx" in u],
                         "an authoritative 404 must not spend a CDX query re-confirming it")

    def test_old_cdx_only_gap_is_reopened_but_a_probe_gap_is_not(self):
        from recovery.cli import needs_probe
        old = {"error": GAP, "attempts": [{"endpoint": "cdx", "error": OK, "captures": 0}]}
        probed = {"error": GAP, "attempts": [{"endpoint": "replay-probe", "error": GAP}]}
        self.assertTrue(needs_probe(old))
        self.assertFalse(needs_probe(probed))

    def test_posts_are_attempted_closest_to_complete_first(self):
        """Finishing a one-image-away post beats starting a twelve-image one."""
        import inspect
        from recovery import cli
        src = inspect.getsource(cli.fetch_images)
        self.assertIn('order == "closest"', src)
        self.assertIn('missing_image_count', src)


class OversizedHostTests(unittest.TestCase):
    """A media host shared by every Tumblr blog must not eat the budget.

    Measured on this site: `24.`/`25.media.tumblr.com` served 40 full CDX pages
    (80k rows) without ever ending, and not one row belonged to this blog. Such
    a host is recorded as `oversized`, and its absence stays *unknown*: only a
    scan that reached its last page (`complete`) may confirm a gap.
    """

    HOST = "24.media.tumblr.com"

    def test_oversized_host_is_recorded_and_reskipped(self):
        from recovery.media import MediaIndex, scan_host

        with tempfile.TemporaryDirectory() as tmp:
            index = MediaIndex(os.path.join(tmp, "media.jsonl"))
            dump = os.path.join(tmp, "dumps")
            # A *full* page is a header plus `page_size` data rows, which is what
            # `_rows(n)` returns. Wrapping each row in a list made every data row
            # one field wide, so parse_cdx_json dropped them all and the scan
            # saw a "short" first page and declared the host complete.
            full = _rows(2000)

            class Sea(FakeArchive):
                def __init__(self):
                    super().__init__({})

                def cdx(self, params, **kw):
                    from urllib.parse import urlencode

                    page = int(params.get("page", 1))
                    body = cdx_json(full if page <= 2 else [["urlkey", "timestamp", "original",
                                                            "mimetype", "statuscode", "digest",
                                                            "length"]])
                    return Response(url="", status=200, body=body, error=OK)

            info = scan_host(Sea(), index, self.HOST, keys={"tumblr_x.jpg"}, page_size=2000,
                             max_pages=2, dump_dir=dump)
            self.assertFalse(info["complete"])
            self.assertTrue(info["oversized"], info)
            state = MediaIndex(os.path.join(tmp, "media.jsonl")).hosts_done()[f"host:{self.HOST}"]
            self.assertTrue(state["oversized"])
            self.assertIsNone(index.host_complete(self.HOST),
                              "an oversized scan is not evidence of a gap")

    def test_full_page_of_filtered_rows_is_not_the_last_page(self):
        """A page whose rows were all dropped is still a full page.

        Judging "did the archive run out?" by the number of *kept* captures made
        a page of after-cutoff rows look like the end of the host, and the scan
        then stamped `complete` on a host it had barely looked at. `complete` is
        what licenses the "confirmed archive gap" verdict for every key of that
        host, so this must not regress.
        """
        from recovery.media import MediaIndex, scan_host

        with tempfile.TemporaryDirectory() as tmp:
            index = MediaIndex(os.path.join(tmp, "media.jsonl"))
            late = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest",
                     "length"]]
            for i in range(2000):  # every row is newer than the cutoff
                late.append([f"k{i}", "20240101000000",
                             f"http://24.media.tumblr.com/{i:032x}/tumblr_other{i}_500.jpg",
                             "image/jpeg", "200", "ABC", "100"])

            class Sea(FakeArchive):
                def __init__(self):
                    super().__init__({})

                def cdx(self, params, **kw):
                    page = int(params.get("page", 1))
                    body = cdx_json(late if page == 1 else [["urlkey", "timestamp", "original",
                                                            "mimetype", "statuscode", "digest",
                                                            "length"]])
                    resp = Response(url="", status=200, body=body, error=OK)
                    resp.cdx_rows = len(body) - 1  # header excluded
                    return resp

            info = scan_host(Sea(), index, self.HOST, keys={"tumblr_x.jpg"}, page_size=2000,
                             max_pages=1, dump_dir=os.path.join(tmp, "dumps"))
            self.assertFalse(info["complete"], info)
            self.assertIsNone(index.host_complete(self.HOST))
            self.assertEqual(info["rows"], 2000, "the raw row count must still be recorded")

    def test_discover_media_skips_an_oversized_host(self):
        import inspect

        from recovery import cli

        src = inspect.getsource(cli.discover_media)
        self.assertIn("oversized", src)
        self.assertIn("not conclusive", src)


def _rows(n: int) -> list:
    """`n` distinct archived media rows for a host that belongs to other blogs."""
    rows = [["urlkey", "timestamp", "original", "mimetype", "statuscode", "digest", "length"]]
    for i in range(n):
        rows.append([f"k{i}", "20140101000000",
                     f"http://24.media.tumblr.com/{i:032x}/tumblr_other{i}r3it8zo1_500.jpg",
                     "image/jpeg", "200", "ABC", "100"])
    return rows
