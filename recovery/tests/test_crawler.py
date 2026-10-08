"""Failure-case tests for the crawler: cutoffs, gaps, timeouts, bad bodies."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import unittest

from recovery import config
from recovery.cdx import Capture, CaptureIndex, cdx_query, parse_cdx_json, within_cutoff
from recovery.http import BAD_BODY, GAP, OK, THROTTLED, TIMEOUT, TRANSPORT, Fetcher, RecoveryError, Response
from recovery.images import (image_capture_candidates, image_capture_candidates_stem,
                             resolve_image, sniff_image, stem_prefix)
from recovery.media import MediaIndex
from recovery.stemindex import StemIndex
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


class StemMethodTests(unittest.TestCase):
    """`--method stem` must consult every URL form, not only the linked shard.

    Post 29905114965 (2026-10): the post linked `25.media.tumblr.com` (whose
    stem the index answered as a miss) while the bytes were archived under
    `31.media.tumblr.com` (a recorded stem *hit*). The stem step only asked the
    linked shard's stem, so it declared a gap for an image whose bytes the
    index already held, and the hit could not be converted.
    """

    LINK = "http://25.media.tumblr.com/tumblr_m947u12PIw1r3it8zo1_500.jpg"
    OTHER = "http://31.media.tumblr.com/tumblr_m947u12PIw1r3it8zo1_500.jpg"

    def _index(self, tmp: str, link_hit: bool) -> StemIndex:
        idx = StemIndex(os.path.join(tmp, "stems.jsonl"))
        cap = Capture(timestamp="20140111015219", original=self.OTHER,
                      statuscode="200", mimetype="image/jpeg", urlkey="k",
                      digest="IGIWWWZE2JJDZZONKBY6KD6WA4OEW6G2", length="64646",
                      redirect="None", source_query="stem-scan")
        idx.record(stem_prefix(self.LINK), [])
        idx.record(stem_prefix(self.OTHER), [cap] if link_hit else [])
        return idx

    def test_stem_step_answers_alternate_form_stems(self):
        with tempfile.TemporaryDirectory() as tmp:
            idx = self._index(tmp, link_hit=True)
            f = FakeArchive({})
            caps, attempts, _after = image_capture_candidates_stem(
                f, self.LINK, stem_index=idx, extra_urls=[self.OTHER])
        self.assertEqual([c.original for c in caps], [self.OTHER])
        batch_attempts = [a for a in attempts if a.get("endpoint") == "cdx-stem-batch"]
        self.assertEqual({a["stem"] for a in batch_attempts},
                         {stem_prefix(self.LINK), stem_prefix(self.OTHER)})
        self.assertEqual(f.requests, [], "a recorded answer must not be re-asked")

    def test_resolve_stem_recovers_from_the_other_shard(self):
        with tempfile.TemporaryDirectory() as tmp:
            idx = self._index(tmp, link_hit=True)
            f = FakeArchive({"web/20140111015219id_": binary(JPEG_BYTES)})
            rec = resolve_image(
                f, {"media_url": self.LINK, "caption_alt": "", "found_in": "img",
                    "url_forms": [self.LINK, self.OTHER]},
                method="stem", stem_index=idx)
        self.assertEqual(rec["state"], "recovered", rec.get("note"))
        self.assertEqual(rec["capture"]["original"], self.OTHER)
        self.assertEqual(rec["capture"]["timestamp"], "20140111015219")


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
        # The availability API still lists a pre-cutoff capture, so the post is
        # retried -- but only a bounded number of times (SNAPSHOT_MAX_RETRIES /
        # MAX_FAILURES). After that budget it is never picked up again.
        retries = 0
        for _ in range(self.cli.SNAPSHOT_MAX_RETRIES + self.cli.MAX_FAILURES + 2):
            if self.cli.fetch_posts(f, limit=5, concurrency=1)["processed"] == 0:
                break
            retries += 1
        self.assertGreaterEqual(retries, 2,
                                "a snapshot_exists post must be retried, not abandoned once")
        again = self.cli.fetch_posts(f, limit=5, concurrency=1)
        self.assertEqual(again["processed"], 0, again)

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
        """Finishing a one-image-away post beats starting a twelve-image one.

        The ordering moved into the durable queue, so the guard is now that
        `fetch_images` still defaults to `closest` and forwards the choice to
        `ImageQueue.select` (which is what the queue tests exercise directly).
        """
        import inspect
        from recovery import cli
        from recovery.queue import ImageQueue
        src = inspect.getsource(cli.fetch_images)
        self.assertIn("order: str = \"closest\"", src)
        self.assertIn("order=order", src)
        self.assertIn("missing_image_count", inspect.getsource(ImageQueue.select))
        one_away = {"post_id": "801", "missing_image_count": 1,
                    "images": [{"media_url": "http://29.media.tumblr.com/a_500.jpg",
                                "state": "missing"}]}
        twelve = {"post_id": "800", "missing_image_count": 12,
                  "images": [{"media_url": f"http://29.media.tumblr.com/{i}_500.jpg",
                              "state": "missing"} for i in range(12)]}
        batch, _stats = ImageQueue().select([twelve, one_away], limit=1, order="closest")
        self.assertEqual([pid for pid, _ in batch], ["801"])


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


class AvailabilityMethodTests(unittest.TestCase):
    """`--method availability` must never raise, and must not fake verdicts.

    Regression: the availability branch referenced a bare `AFTER_CUTOFF` name
    that does not exist in this module, so *every* image whose sweep verdict
    was "no snapshot" raised NameError and aborted the whole `fetch-images`
    pass -- the reason 11 confirmed captures sat in `data/cdx/avail.jsonl`
    without ever being replayed.
    """

    def setUp(self):
        import tempfile

        from recovery.availability import AvailabilityIndex, AFTER_CUTOFF, HIT, NO_SNAPSHOT

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.index = AvailabilityIndex(os.path.join(self.tmp.name, "avail.jsonl"))
        self.HIT, self.GAPV, self.AFTER = HIT, NO_SNAPSHOT, AFTER_CUTOFF
        self.url = "http://40.media.tumblr.com/abc/tumblr_x1r3it8zo1_500.jpg"
        self.img = {"media_url": self.url, "caption_alt": "תגובה"}

    def _resolve(self, method="availability", routes=None):
        from recovery.images import resolve_image

        f = FakeArchive(routes or {})
        return resolve_image(f, dict(self.img), method=method, availability=self.index)

    def test_all_gap_verdicts_record_a_scoped_gap_without_raising(self):
        from recovery.images import _variants

        # A sweep row records the timestamp it asked about; `gap_is_trusted`
        # only believes a "no snapshot" asked inside the era the page lived.
        for variant in _variants(self.url):
            self.index.record(variant, self.GAPV, http_status=200,
                              query_ts="20150119000000")
        rec = self._resolve()
        self.assertEqual(rec["state"], "missing")
        self.assertEqual(rec["error"], "archive_gap")
        note = [a for a in rec["attempts"] if a["endpoint"] == "availability-api"][0]
        self.assertTrue(note["verdicts"], "the scope searched must be recorded")

    def test_gap_verdicts_of_unknown_provenance_stay_undecided(self):
        """A "no snapshot" row without a query timestamp proves nothing.

        The API answers empty for URLs it does hold when asked with a short or
        window-edge timestamp, so such rows were kept as `pending` and re-probed
        rather than written off as gaps. This must not silently become a gap.
        """
        from recovery.images import _variants

        for variant in _variants(self.url):
            self.index.record(variant, self.GAPV, http_status=200)
        rec = self._resolve()
        self.assertEqual(rec["state"], "pending")
        self.assertNotEqual(rec["error"], "archive_gap")

    def test_mixed_gap_and_after_cutoff_is_not_a_gap(self):
        from recovery.images import _variants

        variants = _variants(self.url)
        self.index.record(variants[0], self.GAPV, http_status=200)
        self.index.record(variants[1], self.AFTER, http_status=200,
                          timestamp="20200401000000")
        rec = self._resolve()
        self.assertNotEqual(rec["error"], "archive_gap", rec.get("note", ""))
        self.assertNotEqual(rec["state"], "recovered")

    def test_unswept_url_stays_pending_and_spends_no_request(self):
        rec = self._resolve()
        self.assertEqual(rec["state"], "pending")
        self.assertIsNone(rec["error"], "an unswept URL is no answer, not a gap")

    def test_confirmed_hit_replays_and_hashes_the_image(self):
        routes = {self.url: binary(JPEG_BYTES)}
        self.index.record(self.url, self.HIT, timestamp="20150119072952", status="200")
        rec = self._resolve(routes=routes)
        self.assertEqual(rec["state"], "recovered", rec.get("note", ""))
        self.assertEqual(rec["sha256"], hashlib.sha256(JPEG_BYTES).hexdigest())
        self.assertEqual(rec["capture"]["timestamp"], "20150119072952")


class PlainHttpFallbackTests(unittest.TestCase):
    """A runner whose HTTPS route to web.archive.org is refused must still work.

    Real evidence: on this runner `https://web.archive.org` refused the TCP
    connection on every attempt while `http://web.archive.org` answered 200 with
    the exact bytes of post 15577014830's image. Without a downgrade every URL
    looked unreachable (TRANSPORT refusal, status None) and the queue cooled
    down with nothing recovered. A refusal is transport evidence, never a
    throttle verdict.
    """

    URL = ("https://web.archive.org/web/20130930175155im_/"
           "http://29.media.tumblr.com/tumblr_lxjrbav0Ye1r3it8zo1_500.jpg")

    def _fetcher(self):
        from recovery.tests.fixtures import FakeArchive

        class Refused(FakeArchive):
            def _get(self, url, timeout):
                self.requests.append(url)
                if url.startswith("https://"):
                    return Response(url=url, status=None, error=TRANSPORT,
                                    message="connection refused (transport, no HTTP answer)")
                return Response(url=url, status=200, body=JPEG_BYTES,
                                headers={"content-type": "image/jpeg"})

            _get_noredirect = _get

        return Refused({}, sleep=lambda _s: None)

    def test_get_downgrades_to_plain_http_once(self):
        f = self._fetcher()
        resp = f.get(self.URL)
        self.assertEqual(resp.status, 200)
        self.assertTrue(resp.ok)
        self.assertEqual(f.requests[0], self.URL)
        self.assertEqual(f.requests[1], self.URL.replace("https://", "http://", 1))
        self.assertEqual(f.stats.get("scheme_fallback"), 1)
        self.assertFalse(f.blocked, "a refusal that plain HTTP answers must not trip the breaker")

    def test_probe_replay_downgrades_and_reports_the_capture(self):
        f = self._fetcher()
        resp = f.probe_replay("http://29.media.tumblr.com/tumblr_lxjrbav0Ye1r3it8zo1_500.jpg",
                              at_ts="20130930175155")
        self.assertTrue(resp.ok)
        self.assertTrue(any(u.startswith("http://web.archive.org") for u in f.requests))

    def test_a_reachable_https_answer_is_never_downgraded(self):
        from recovery.tests.fixtures import FakeArchive

        f = FakeArchive({"im_/": Response(url="", status=200, body=JPEG_BYTES,
                                          headers={"content-type": "image/jpeg"})})
        resp = f.get(self.URL)
        self.assertEqual(resp.status, 200)
        self.assertEqual(f.requests, [self.URL])
        self.assertNotIn("scheme_fallback", f.stats)


class ArchiveBlockTests(unittest.TestCase):
    """No-answer results must stop the hammering without misdiagnosis.

    Observed on 2026-10-05: after one burst of `fetch-images` (~3 requests/s at
    concurrency 3 with a 0.7s limiter) `web.archive.org` began refusing the TCP
    connection for both curl and python within a minute, and kept refusing for
    the rest of the iteration. Refusals are TRANSPORT (status None, no HTTP
    answer), never proof of throttling: only a genuine 429/503 from a reachable
    front end is THROTTLED. Both classes stop in-process retries and both trip
    the circuit breaker, but the ledger keeps the honest label so a refusal is
    never mistaken for a rate-limit verdict or an archive gap.
    """

    def _refused(self) -> Exception:
        import requests

        # The real chain, as requests builds it: `requests` never exposes a
        # `NewConnectionError` of its own -- that class lives in urllib3, which
        # raises it from inside a `MaxRetryError` whose cause is the socket
        # error. Referencing `requests.exceptions.NewConnectionError` raised
        # AttributeError, so this refusal case never exercised the classifier.
        import urllib3.exceptions as u3e

        refused = ConnectionRefusedError(111, "Connection refused")
        new = u3e.NewConnectionError(None, "Connection refused")
        new.__cause__ = refused
        maxretry = u3e.MaxRetryError(None, "https://web.archive.org/cdx", reason=new)
        exc = requests.exceptions.ConnectionError(
            "HTTPSConnectionPool(host='web.archive.org', port=443): Max retries exceeded")
        exc.__cause__ = maxretry
        return exc

    def test_refused_connection_is_transport_not_throttled(self):
        from recovery.http import classify_exception

        kind, message = classify_exception(self._refused())
        self.assertEqual(kind, TRANSPORT)
        self.assertIn("refused", message.lower())
        self.assertIn("transport", message.lower())

    def test_dns_failure_stays_plain_transport(self):
        import requests

        exc = requests.exceptions.ConnectionError(
            "HTTPSConnectionPool(host='web.archive.org', port=443): Name or service not known")
        exc.__cause__ = OSError("Name or service not known")
        from recovery.http import classify_exception

        self.assertEqual(classify_exception(exc)[0], "transport")

    def test_throttled_request_is_sent_once_not_retried(self):
        sent = []

        class Blocked(FakeArchive):
            def _get(self, url, timeout):
                sent.append(url)
                return Response(url=url, status=429, error=THROTTLED,
                                message="HTTP 429")

        f = Blocked({}, attempts=3, sleep=lambda _s: None)
        # A genuine 429 is answered on a reachable front end, so no scheme
        # fallback applies (fallback is only for no-answer results).
        resp = f.get("https://web.archive.org/web/20191231235959id_/http://x/y.jpg")
        self.assertEqual(resp.error, THROTTLED)
        # No in-process retry: the throttle is handed to the cooldown.
        self.assertEqual(len(sent), 1, "a throttled archive must not be retried in-process")

    def test_refused_transport_is_sent_once_not_retried(self):
        from recovery.http import TRANSPORT
        sent = []

        class Refused(FakeArchive):
            def _get(self, url, timeout):
                sent.append(url)
                return Response(url=url, status=None, error=TRANSPORT,
                                message="connection refused (transport, no HTTP answer)")

            def _get_noredirect(self, url, timeout):
                sent.append(url)
                return Response(url=url, status=None, error=TRANSPORT,
                                message="connection refused (transport, no HTTP answer)")

        f = Refused({}, attempts=3, sleep=lambda _s: None)
        resp = f.get("https://web.archive.org/web/20191231235959id_/http://x/y.jpg")
        self.assertEqual(resp.error, TRANSPORT)
        # One HTTPS request, plus at most the single documented plain-HTTP
        # downgrade (see PlainHttpFallbackTests). No further in-process retry:
        # the refusal is handed to the queue cooldown like a throttle, but the
        # ledger keeps the TRANSPORT label.
        self.assertLessEqual(len(sent), 2, "a refused archive must not be retried in-process")
        self.assertEqual(sent[0].startswith("https://web.archive.org/"), True)
        for extra in sent[1:]:
            self.assertTrue(extra.startswith("http://web.archive.org/"), extra)

    def test_repeated_throttles_open_a_circuit_and_stop_sending(self):
        sent = []

        class Blocked(FakeArchive):
            def _get(self, url, timeout):
                sent.append(url)
                return Response(url=url, status=429, error=THROTTLED, message="HTTP 429")

            def _get_noredirect(self, url, timeout):
                sent.append(url)
                return Response(url=url, status=429, error=THROTTLED, message="HTTP 429")

        f = Blocked({}, attempts=3, sleep=lambda _s: None)
        for i in range(3):
            f.get(f"https://web.archive.org/x{i}")
        self.assertTrue(f.blocked, "3 consecutive throttles must open the circuit")
        before = len(sent)
        again = f.get("https://web.archive.org/after")
        self.assertEqual(again.error, THROTTLED)
        self.assertEqual(len(sent), before, "no request may be sent while the circuit is open")
        self.assertIn("circuit breaker", again.message)
        self.assertIn("no request was sent", again.message)

    def test_repeated_refusals_open_a_circuit_with_transport_label(self):
        from recovery.http import TRANSPORT
        sent = []

        class Refused(FakeArchive):
            def _get(self, url, timeout):
                sent.append(url)
                return Response(url=url, status=None, error=TRANSPORT,
                                message="connection refused (transport, no HTTP answer)")

            def _get_noredirect(self, url, timeout):
                sent.append(url)
                return Response(url=url, status=None, error=TRANSPORT,
                                message="connection refused (transport, no HTTP answer)")

        f = Refused({}, attempts=3, sleep=lambda _s: None)
        # Each get() sends https + one http fallback (2 requests) then stops.
        f.get("https://web.archive.org/r0")
        f.get("https://web.archive.org/r1")
        # Third consecutive no-answer trips the breaker during the call.
        f.get("https://web.archive.org/r2")
        self.assertTrue(f.blocked, "3 consecutive refusals must open the circuit")
        before = len(sent)
        again = f.get("https://web.archive.org/after")
        self.assertEqual(again.error, TRANSPORT,
                         "a transport block must keep the TRANSPORT label, not THROTTLED")
        self.assertEqual(len(sent), before, "no request may be sent while the circuit is open")
        self.assertIn("circuit breaker", again.message)
        self.assertIn("no request was sent", again.message)

    def test_answered_gap_resets_the_no_answer_streak(self):
        from recovery.http import GAP, TRANSPORT
        sent = []

        class Flap(FakeArchive):
            def _get(self, url, timeout):
                sent.append(url)
                if "gap" in url:
                    return Response(url=url, status=404, error=GAP, message="HTTP 404")
                return Response(url=url, status=None, error=TRANSPORT,
                                message="connection refused (transport, no HTTP answer)")

            def _get_noredirect(self, url, timeout):
                return self._get(url, timeout)

        f = Flap({}, attempts=1, sleep=lambda _s: None)
        f.get("https://web.archive.org/a")
        f.get("https://web.archive.org/b")
        self.assertFalse(f.blocked)
        # An answered 404 proves reachability and resets the streak.
        f.get("https://web.archive.org/gap")
        f.get("https://web.archive.org/c")
        self.assertFalse(f.blocked, "an answered gap must reset the no-answer streak")

    def test_one_good_answer_closes_the_circuit(self):
        class Flaky(FakeArchive):
            def _get(self, url, timeout):
                if "bad" in url:
                    return Response(url=url, status=None, error=THROTTLED, message="refused")
                return Response(url=url, status=200, body=b"ok", error=OK)

        f = Flaky({})
        for i in range(3):
            f.get(f"https://web.archive.org/bad{i}")
        self.assertTrue(f.blocked)
        # While the circuit is open ordinary traffic is never sent, so the
        # health check is the only path back: it is a single `trial=True`
        # request, and a good answer there closes the circuit.
        self.assertEqual(f.get("https://web.archive.org/good").error, THROTTLED)
        f.get("https://web.archive.org/good", trial=True)
        self.assertFalse(f.blocked, "a successful answer must close the circuit")


class RecoveryNoteTests(unittest.TestCase):
    """A recovered image must not keep an earlier pass's gap claim as its note."""

    URL = "http://29.media.tumblr.com/tumblr_aaa_500.jpg"

    def _routes(self):
        return {"im_/": Response(url="", status=302, body=b"",
                                 headers={"location": f"https://web.archive.org/web/20130930175155im_/{self.URL}"},
                                 error=OK),
                "id_/": binary(JPEG_BYTES)}

    def test_recovery_note_supersedes_the_old_gap_verdict(self):
        f = FakeArchive(self._routes())
        record = {"media_url": self.URL,
                  "note": "replay probes answered for this URL and none of them has a capture"}
        rec = resolve_image(f, record, method="probe", max_captures=1)
        self.assertEqual(rec["state"], "recovered")
        self.assertNotIn("none of them has a capture", rec["note"])
        self.assertIn("20130930175155", rec["note"])
        self.assertEqual(rec["prior_note"], record["note"],
                         "the superseded verdict is kept, not deleted")
