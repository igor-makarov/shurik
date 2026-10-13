# Native integration fixtures

`images/sample.*` contains the same 2x2 red/green/blue/white image encoded as PNG, JPEG, GIF, WebP, and BMP. Tests verify native MIME detection, complete attachment bytes, model limits, text pagination, and unsupported-format diagnostics. The fixtures need no image libraries at test time.

`pi-durable-1.0.2/` is an unchanged native JSONL journal and its sidecars, written by Shurik 1.1.10 with Pi Durable / Chord 1.0.2 and Pi AI 1.1.0. A scripted model completed a `write` call containing `LEGACY_COMPLETED_TOOL_NEEDLE`, then began a `bash` call that prints a marker and sleeps. The process group was killed while that version-1 tool was running. Transcript bounds are entries 7 through 17. Tests always copy the fixture before inspection or execution and verify that the new engine can abort pending work and retrieve the completed history. It contains synthetic model responses and no credentials.
