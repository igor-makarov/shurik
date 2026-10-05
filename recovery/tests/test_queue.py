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
import time
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


class ArchiveLivenessTests(unittest.TestCase):
    """A recorded global cooldown must not strand the queue past the outage.

    The queue file records a cooldown *deadline*, set during whatever archive
    outage happened in an earlier iteration. web.archive.org routinely recovers
    long before that deadline expires, and while it is in force `fetch_images`
    returns before selecting anything -- so a whole iteration can do nothing at
    all while 1186 never-attempted images stay untouched. One bounded probe of a
    known-archived URL is enough to tell the two cases apart.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = self._tmp.name
        self.queue_path = os.path.join(self.tmp, "image-queue.json")

    def _cooled_queue(self) -> ImageQueue:
        q = ImageQueue(self.queue_path)
        q.note_global_failure("8 transient image failures in this pass")
        q.save()
        return ImageQueue(self.queue_path)

    def test_healthy_archive_clears_a_stale_cooldown_and_work_runs(self):
        from recovery.cli import fetch_images

        q = self._cooled_queue()
        self.assertTrue(q.global_cooldown_active())
        routes = {"lxjrbav0Ye1r3it8zo1": Response(  # the liveness probe URL
            url="", status=302, error=OK,
            headers={"location": "https://web.archive.org/web/20130930175155im_/http://29.media"
                                ".tumblr.com/tumblr_lxjrbav0Ye1r3it8zo1_500.jpg"})}
        out = fetch_images(FakeArchive(routes, sleep=lambda _s: None), limit_posts=1,
                           post_ids=["1"], queue=ImageQueue(self.queue_path),
                           publish_on_recovery=False, health_check=True)
        self.assertIn("cooldown_cleared_by_health_check", out)
        self.assertTrue(out["cooldown_cleared_by_health_check"]["healthy"])
        self.assertIsNone(ImageQueue(self.queue_path).global_cooldown_active(),
                          "a cleared cooldown must not survive in the committed queue file")

    def test_unhealthy_archive_keeps_the_cooldown_and_sends_no_image_request(self):
        from recovery.cli import fetch_images

        q = self._cooled_queue()
        fetcher = FakeArchive({}, sleep=lambda _s: None)
        out = fetch_images(fetcher, limit_posts=1, queue=ImageQueue(self.queue_path),
                           publish_on_recovery=False, health_check=True)
        self.assertEqual(out["processed"], 0)
        self.assertIn("global archive cooldown", out["note"])
        self.assertFalse(out["health_check"]["healthy"])
        self.assertTrue(ImageQueue(self.queue_path).global_cooldown_active(),
                        "an unanswered probe must leave the back-off in force")

    def test_health_check_is_one_request_and_can_be_disabled(self):
        from recovery.cli import archive_health

        fetcher = FakeArchive({"lxjrbav": Response(url="", status=302, error=OK,
                                                  headers={"location": "https://web.archive.org"
                                                           "/web/20130930175155im_/http://x"})})
        out = archive_health(fetcher)
        self.assertTrue(out["healthy"])
        self.assertEqual(len(fetcher.requests), 1, "liveness costs exactly one request")
        self.assertEqual(fetcher.requests[0].count("im_"), 1)

        blocked = FakeArchive({"lxjrbav": Response(url="", status=504, error=THROTTLED,
                                                  message="gateway timeout")})
        self.assertFalse(archive_health(blocked)["healthy"])


class CircuitBreakerDeferralTests(unittest.TestCase):
    """An open circuit must not spend the batch on posts nobody could ask.

    When the archive throttles mid-pass the fetcher's breaker refuses further
    requests. Each refused request used to be recorded as a real `throttled`
    attempt: the whole batch burned, every untouched post was pushed into a
    cooldown it never earned, and the queue looked busy while learning nothing.
    """

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = self._tmp.name
        self.queue_path = os.path.join(self.tmp, "image-queue.json")
        self.post_dir = os.path.join(self.tmp, "posts")

    def _seed(self, n: int) -> list[str]:
        os.makedirs(self.post_dir, exist_ok=True)
        ids = []
        for i in range(n):
            pid = str(1000 + i)
            ids.append(pid)
            with open(os.path.join(self.post_dir, f"{pid}.json"), "w", encoding="utf-8") as fh:
                json.dump(post(pid, [image(f"http://29.media.tumblr.com/tumblr_{i}_500.jpg")]), fh)
        return ids

    def _run(self, fetcher, **kw):
        from recovery.cli import fetch_images

        old_dir, old_missing = config.POST_DIR, config.MISSING_JSONL
        config.POST_DIR = self.post_dir
        config.MISSING_JSONL = os.path.join(self.tmp, "missing.jsonl")
        try:
            return fetch_images(fetcher, limit_posts=kw.pop("limit_posts", 10),
                                queue=ImageQueue(self.queue_path), publish_on_recovery=False,
                                health_check=False, concurrency=1, variant_budget=1, **kw)
        finally:
            config.POST_DIR, config.MISSING_JSONL = old_dir, old_missing

    def test_open_circuit_defers_every_post_without_spending_attempts(self):
        ids = self._seed(4)
        fetcher = FakeArchive({}, sleep=lambda _s: None)
        fetcher._blocked_until = time.monotonic() + 600  # breaker already open

        out = self._run(fetcher)

        self.assertEqual(out["processed"], 4)
        self.assertEqual(out["deferred"], 4, out)
        self.assertEqual(out["recovered"], 0)
        self.assertEqual(fetcher.requests, [], "no request may be sent while the circuit is open")
        self.assertIn("circuit breaker", out.get("circuit_breaker", ""))
        q = ImageQueue(self.queue_path)
        for pid in ids:
            self.assertEqual(q.attempts(pid), 0,
                             f"post {pid} spent an attempt on an archive that never answered")
            self.assertFalse(q.cooling_down(pid))
        # The untouched records must still look untouched.
        with open(os.path.join(self.post_dir, f"{ids[0]}.json"), encoding="utf-8") as fh:
            rec = json.load(fh)
        self.assertEqual(rec["images"][0].get("attempts", []), [])
        self.assertNotEqual(rec.get("images_done"), True)

    def test_a_post_cut_short_mid_way_keeps_its_later_images_unasked(self):
        ids = self._seed(2)
        routes = {"im_/": Response(url="", status=429, error=THROTTLED, message="slow down")}

        class Tripping(FakeArchive):
            def _get_noredirect(self, url, timeout):
                resp = routes["im_/"]
                self.requests.append(url)
                return Response(url=url, status=resp.status, error=resp.error,
                                message=resp.message)

        out = self._run(Tripping(routes, sleep=lambda _s: None), limit_posts=2)

        self.assertEqual(out["deferred"] + out["transient"], out["transient"] + out["transient"])
        self.assertGreaterEqual(out["deferred"], 1, out)
        q = ImageQueue(self.queue_path)
        deferred = [pid for pid in ids if q.attempts(pid) == 0]
        self.assertTrue(deferred, "the post behind the open circuit must stay unattempted")
        for pid in deferred:
            with open(os.path.join(self.post_dir, f"{pid}.json"), encoding="utf-8") as fh:
                rec = json.load(fh)
            self.assertEqual(rec["images"][0].get("attempts", []), [])
            self.assertNotEqual(rec.get("images_done"), True)
        self.assertIsNotNone(ImageQueue(self.queue_path).global_cooldown_active(),
                             "a pass cut short by throttling must record its cooldown")

    def test_deferred_posts_are_still_selected_by_the_next_pass(self):
        self._seed(2)
        fetcher = FakeArchive({}, sleep=lambda _s: None)
        fetcher._blocked_until = time.monotonic() + 600
        self._run(fetcher)
        # A fresh process, with a healthy archive: the deferred posts are still
        # at the front of the line, untouched by the outage.
        records = list(__import__("recovery.store", fromlist=["PostStore"]).PostStore(
            self.post_dir).all())
        batch, stats = ImageQueue(self.queue_path).select(records, limit=5)
        self.assertEqual(stats["posts_with_work"], 2, stats)
        self.assertEqual([pid for pid, _ in batch], ["1000", "1001"], batch)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()