"""The recovery queue must advance, not spin.

Every test here is offline and builds the state that used to break the crawl:
a wall of terminal gaps at the front of the queue, posts with transient
failures, posts nobody has ever asked, and a fresh process that has to resume
from the committed queue file alone.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest

from recovery import config
from recovery.http import GAP, OK, THROTTLED, TIMEOUT
from recovery.images import image_capture_candidates_probe
from recovery.queue import QUEUE_VERSION, ImageQueue, variant_outcomes
from recovery.tests.fixtures import FakeArchive, Response

MEDIA = "http://29.media.tumblr.com/tumblr_aaa_500.jpg"


def image(url: str = MEDIA, **kw) -> dict:
    img = {"media_url": url, "media_key": os.path.basename(url), "state": "missing",
           "error": None, "attempts": [], "caption": ""}
    img.update(kw)
    return img


def post(pid: str, images: list[dict]) -> dict:
    return {"post_id": pid, "images": images,
            "image_count": len([i for i in images if i.get("sha256")]),
            "missing_image_count": len([i for i in images if not i.get("sha256")])}


def probe_attempt(url: str, error: str) -> dict:
    return {"url": url, "endpoint": "replay-probe", "error": error, "status": 404,
            "capture_timestamp": None, "requested_timestamp": config.CUTOFF}


class QueueSelectionTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = os.path.join(self._tmp.name, "image-queue.json")

    def queue(self, **kw) -> ImageQueue:
        return ImageQueue(self.path, **kw)

    def test_terminal_gaps_at_the_front_do_not_consume_the_batch(self):
        """The 32-of-40 waste: settled posts must be filtered *before* the limit."""
        settled = [post(str(100 + i), [image(error=GAP,
                                            attempts=[probe_attempt(MEDIA, GAP)])])
                   for i in range(32)]
        fresh = [post(str(200 + i), [image()]) for i in range(8)]
        batch, stats = self.queue().select(settled + fresh, limit=5)
        self.assertEqual([pid for pid, _ in batch], ["200", "201", "202", "203", "204"], batch)
        self.assertEqual(stats["no_work_left"], 32)
        self.assertEqual(stats["posts_with_work"], 8)
        self.assertEqual(stats["remaining_with_work"], 3)

    def test_repeated_passes_advance_to_untouched_posts(self):
        records = [post(str(300 + i), [image()]) for i in range(6)]
        q = self.queue()
        seen: list[str] = []
        for _ in range(3):
            batch, _stats = q.select(records, limit=2)
            for pid, entries in batch:
                seen.append(pid)
                q.note_attempt(pid, entries, {"outcome": "settled", "recovered": 0})
            q.save()
        self.assertEqual(len(seen), 6, seen)
        self.assertEqual(len(set(seen)), 6, "each pass must reach new posts, not the same two")

    def test_fresh_process_resumes_from_the_committed_queue(self):
        records = [post("400", [image()]), post("401", [image()]), post("402", [image()])]
        q = self.queue()
        batch, _ = q.select(records, limit=1)
        for pid, entries in batch:
            q.note_attempt(pid, entries, {"outcome": "settled"})
        q.save()

        fresh = ImageQueue(self.path)          # a brand new process
        batch2, _ = fresh.select(records, limit=1)
        self.assertEqual([pid for pid, _ in batch2], ["401"])
        self.assertEqual(fresh.attempts("400"), 1)

    def test_transient_failure_cools_the_post_down_without_blocking_others(self):
        records = [post("500", [image()]), post("501", [image()])]
        q = self.queue(cooldown_minutes=30)
        batch, _ = q.select(records, limit=2)
        wanted = dict(batch)
        q.note_attempt("500", wanted["500"], {"outcome": "transient", "transient": 1})
        q.save()
        self.assertTrue(ImageQueue(self.path).cooling_down("500"))
        again, stats = ImageQueue(self.path).select(records, limit=5)
        self.assertEqual([pid for pid, _ in again], ["501"])
        self.assertEqual(stats["cooling_down"], 1)

    def test_a_failed_item_does_not_stop_the_rest_of_the_batch(self):
        records = [post("600", [image(error=TIMEOUT)]), post("601", [image()]),
                   post("602", [image(error=THROTTLED)])]
        batch, stats = self.queue().select(records, limit=3, final_errors=("archive_gap",))
        self.assertEqual([pid for pid, _ in batch], ["600", "601", "602"])
        self.assertEqual(stats["posts_with_work"], 3)

    def test_recovered_images_are_never_selected_again(self):
        done = post("700", [image(sha256="a" * 64, state="recovered")])
        batch, stats = self.queue().select([done], limit=10)
        self.assertEqual(batch, [])
        self.assertEqual(stats["posts_with_work"], 0)

    def test_closest_to_complete_wins_inside_one_attempt_count(self):
        nearly = post("801", [image(), image("http://29.media.tumblr.com/tumblr_b_500.jpg")])
        far = post("800", [image() for _ in range(12)])
        batch, _ = self.queue().select([far, nearly], limit=1, order="closest")
        self.assertEqual([pid for pid, _ in batch], ["801"])

    def test_attempt_cap_bounds_a_hopeless_post(self):
        records = [post("900", [image()]), post("901", [image()])]
        q = self.queue(max_attempts=2)
        picked: list[str] = []
        for _ in range(6):
            batch, _stats = q.select(records, limit=1)
            if not batch:
                break
            pid, entries = batch[0]
            picked.append(pid)
            q.note_attempt(pid, entries, {"outcome": "settled"})
        self.assertLessEqual(picked.count("900"), 2,
                             f"post 900 was attempted {picked.count('900')} times")
        self.assertIn("901", picked, "the cap must not starve the other post")
        again, stats = q.select(records, limit=5)
        self.assertNotIn("900", [pid for pid, _ in again])
        # Both posts are equally hopeless here, so both are capped -- the point
        # is that neither is retried forever and neither starves the other.
        self.assertEqual(stats["attempt_capped"], 2)

    def test_global_cooldown_is_recorded_and_blocks_archive_work(self):
        q = self.queue()
        self.assertIsNone(q.global_cooldown_active())
        for _ in range(2):
            q.note_global_failure("connection refused")
        q.save()
        active = ImageQueue(self.path).global_cooldown_active()
        self.assertTrue(active and "cooldown" in active, active)
        recovered = ImageQueue(self.path)
        recovered.note_global_success()
        recovered.save()
        self.assertIsNone(ImageQueue(self.path).global_cooldown_active())


class VariantFairnessTests(unittest.TestCase):
    """Repeated passes must try *different* size/extension variants."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.path = os.path.join(self._tmp.name, "image-queue.json")

    def test_probe_sweep_skips_variants_an_earlier_pass_settled(self):
        img = image()
        first = FakeArchive({"im_/": Response(url="", status=404, error=GAP)})
        _caps, attempts, _after = image_capture_candidates_probe(first, MEDIA, variant_budget=2)
        asked_first = [a["url"] for a in attempts if a.get("endpoint") == "replay-probe"]
        self.assertEqual(len(asked_first), 3, asked_first)   # exact + 2 siblings
        settled = {u: "gap" for u in asked_first}

        q = ImageQueue(self.path)
        untried = q.untried_variants(MEDIA, settled)
        self.assertTrue(untried, "a variant must remain after a budgeted sweep")
        self.assertNotIn(MEDIA, untried)

        second = FakeArchive({"im_/": Response(url="", status=404, error=GAP)})
        _caps2, attempts2, _after2 = image_capture_candidates_probe(
            second, MEDIA, variant_budget=2, skip_variants=settled)
        asked_second = {a["url"] for a in attempts2 if a.get("endpoint") == "replay-probe"}
        self.assertTrue(asked_second)
        self.assertFalse(asked_second & set(asked_first),
                         "the second pass must not re-ask the first pass's variants")

    def test_variant_outcomes_read_the_attempt_log(self):
        img = image(attempts=[probe_attempt(MEDIA, GAP), probe_attempt(MEDIA + "x", TIMEOUT)])
        out = variant_outcomes(img)
        self.assertEqual(out[MEDIA], "gap")
        self.assertEqual(out[MEDIA + "x"], TIMEOUT)
        self.assertNotIn(TIMEOUT, ("gap",), "a timeout is not a terminal verdict")


class QueueFileTests(unittest.TestCase):
    def test_queue_file_is_committed_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "image-queue.json")
            q = ImageQueue(path)
            q.note_attempt("1", [{"image": image(), "media_url": MEDIA, "tried": []}],
                           {"outcome": "recovered", "recovered": 1})
            q.save()
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
            self.assertEqual(data["version"], QUEUE_VERSION)
            self.assertEqual(data["posts"]["1"]["attempts"], 1)
            self.assertEqual(data["posts"]["1"]["recovered"], 1)

    def test_an_older_queue_file_still_loads(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "image-queue.json")
            with open(path, "w", encoding="utf-8") as fh:
                json.dump({"version": 2, "posts": {"1": {"attempts": 1, "variants": {}}}, "global": {}}, fh)
            q = ImageQueue(path)
            self.assertEqual(q.attempts("1"), 1)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()