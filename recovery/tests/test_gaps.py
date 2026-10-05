"""Gap-proof tests: the distinctions that stop a retry loop from lying to us."""
from __future__ import annotations

import unittest

from recovery.gaps import DEFAULT_ALT_HOSTS, best_capture, file_key, prove, query_forms
from recovery.http import OK, THROTTLED, TIMEOUT, Response

EMPTY_BODY = b"[]"
HIT_BODY = (
    b'[["urlkey","timestamp","original","mimetype","statuscode"],'
    b'["com,tumblr,media,40)/46281703ea29ab2c507f5bc4485c62ec/'
    b'tumblr_ndozw9k7dz1r3it8zo1_500.jpg","20150119072952",'
    b'"http://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/'
    b'tumblr_ndozw9K7Dz1r3it8zo1_500.jpg","image/jpeg","200"]]'
)


class FakeFetcher:
    """Answers CDX queries from a canned map keyed by the queried URL."""

    def __init__(self, answers: dict | None = None, default=None):
        self.answers = answers or {}
        self.default = default
        self.queries: list[str] = []

    def cdx(self, params: dict, **kw) -> Response:
        url = params["url"]
        self.queries.append(url)
        if url in self.answers:
            return self.answers[url]
        if self.default is not None:
            return self.default
        return Response(url=f"cdx?{url}", status=200, body=EMPTY_BODY, error=OK)


def resp(status=200, body=EMPTY_BODY, error=OK, url="cdx"):
    return Response(url=url, status=status, body=body, error=error)


class FileKeyTests(unittest.TestCase):
    def test_md5_directory_wins_over_size_and_extension(self):
        self.assertEqual(
            file_key("http://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/tumblr_ndozw9K7Dz1r3it8zo1_500.jpg"),
            ("dir", "46281703ea29ab2c507f5bc4485c62ec"),
        )
        self.assertEqual(
            file_key("http://78.media.tumblr.com/deadbeefdeadbeefdeadbeefdeadbeef/tumblr_abc_1280.png"),
            ("dir", "deadbeefdeadbeefdeadbeefdeadbeef"),
        )

    def test_unhashed_name_collapses_sizes(self):
        for size in ("500", "1280", "540"):
            self.assertEqual(
                file_key(f"http://24.media.tumblr.com/tumblr_m4ulu8rpDN1r3it8zo1_{size}.jpg"),
                ("stem", "tumblr_m4ulu8rpDN1r3it8zo1"),
            )

    def test_non_media_url_is_not_a_file_key(self):
        self.assertEqual(file_key("https://hazfalafel.com/post/100403945458"), ("", ""))
        self.assertEqual(file_key("http://24.media.tumblr.com/avatar_1280.png"), ("", ""))


class QueryFormTests(unittest.TestCase):
    URL = "http://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/tumblr_ndozw9K7Dz1r3it8zo1_500.jpg"

    def test_one_prefix_query_covers_every_size_and_both_schemes(self):
        urls = [p["url"] for p in query_forms(self.URL, alt_hosts=1)]
        self.assertIn("http://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/*", urls)
        self.assertIn("https://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/*", urls)
        self.assertIn("http://media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/*", urls)

    def test_cheaper_than_the_exact_plus_variant_sweep_it_replaces(self):
        self.assertLessEqual(len(query_forms(self.URL, alt_hosts=1)), 8)

    def test_alternate_host_budget_is_bounded(self):
        plans = query_forms(self.URL, alt_hosts=2)
        hosts = [p["host"] for p in plans]
        self.assertEqual(hosts.count("40.media.tumblr.com"), 2, "one per scheme")
        alternates = {h for h in hosts if h not in ("40.media.tumblr.com", "media.tumblr.com")}
        self.assertEqual(len(alternates), 2, "budget of 2 alternate CDN hosts")
        self.assertTrue(alternates.issubset(set(DEFAULT_ALT_HOSTS)))

    def test_unhashed_url_asks_the_hostless_cdn_form_by_filename(self):
        plans = query_forms("http://78.media.tumblr.com/tumblr_m4ulu8rpDN1r3it8zo1_500.jpg",
                            alt_hosts=0)
        urls = [p["url"] for p in plans]
        self.assertIn("http://78.media.tumblr.com/tumblr_m4ulu8rpDN1r3it8zo1*", urls)
        self.assertIn("http://media.tumblr.com/tumblr_m4ulu8rpDN1r3it8zo1*", urls)


class ProveTests(unittest.TestCase):
    URL = "http://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/tumblr_ndozw9K7Dz1r3it8zo1_500.jpg"

    def test_all_empty_200_answers_is_a_confirmed_gap(self):
        row = prove(FakeFetcher(), self.URL, alt_hosts=1)
        self.assertEqual(row["result"], "confirmed_gap")
        self.assertTrue(all(q["rows"] == 0 for q in row["queries"]))
        self.assertTrue(all(q["status"] == 200 for q in row["queries"]))

    def test_throttling_is_not_a_gap(self):
        bad = resp(status=429, body=b"", error=THROTTLED)
        fetcher = FakeFetcher(answers={f"http://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/*": bad})
        self.assertEqual(prove(fetcher, self.URL, alt_hosts=1)["result"], "inconclusive")

    def test_timeout_is_not_a_gap(self):
        bad = resp(status=0, body=b"", error=TIMEOUT)
        fetcher = FakeFetcher(answers={f"https://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/*": bad})
        self.assertEqual(prove(fetcher, self.URL, alt_hosts=1)["result"], "inconclusive")

    def test_server_error_is_not_a_gap(self):
        bad = resp(status=503, body=b"", error=THROTTLED)
        fetcher = FakeFetcher(answers={f"http://media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/*": bad})
        self.assertEqual(prove(fetcher, self.URL, alt_hosts=1)["result"], "inconclusive")

    def test_a_capture_anywhere_wins_and_stops_the_sweep(self):
        hit_url = f"https://40.media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/*"
        fetcher = FakeFetcher(answers={hit_url: resp(body=HIT_BODY)})
        row = prove(fetcher, self.URL, alt_hosts=1)
        self.assertEqual(row["result"], "capture_found")
        self.assertTrue(row["captures"])
        self.assertEqual(fetcher.queries[-1], hit_url, "must stop issuing queries at the first hit")

    def test_a_capture_on_another_cdn_host_still_counts(self):
        hit_url = "http://media.tumblr.com/46281703ea29ab2c507f5bc4485c62ec/*"
        fetcher = FakeFetcher(answers={hit_url: resp(body=HIT_BODY)})
        self.assertEqual(prove(fetcher, self.URL, alt_hosts=1)["result"], "capture_found")

    def test_not_media_urls_are_skipped_without_queries(self):
        fetcher = FakeFetcher()
        row = prove(fetcher, "https://hazfalafel.com/post/100403945458")
        self.assertEqual(row["result"], "not_media")
        self.assertEqual(row["queries"], [])
        self.assertEqual(fetcher.queries, [])


class BestCaptureTests(unittest.TestCase):
    def test_prefers_newest_pre_cutoff_image(self):
        rows = [
            {"timestamp": "20140101000000", "mimetype": "image/jpeg", "statuscode": "200"},
            {"timestamp": "20160101000000", "mimetype": "image/jpeg", "statuscode": "200"},
            {"timestamp": "20210501000000", "mimetype": "image/jpeg", "statuscode": "200"},
            {"timestamp": "20180101000000", "mimetype": "text/html", "statuscode": "200"},
            {"timestamp": "20190101000000", "mimetype": "image/jpeg", "statuscode": "302"},
        ]
        self.assertEqual(best_capture(rows)["timestamp"], "20160101000000")

    def test_returns_none_when_only_unusable_captures(self):
        self.assertIsNone(best_capture([{"timestamp": "20210501000000", "mimetype": "image/jpeg"}]))
        self.assertIsNone(best_capture([]))


if __name__ == "__main__":
    unittest.main()