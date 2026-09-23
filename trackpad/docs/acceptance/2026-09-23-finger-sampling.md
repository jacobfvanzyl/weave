# WVE-81: coalesced finger input

23 September 2026. The user requested improvements to finger input only after
discussing sampling, callback delivery, and latency. Pencil sampling, hover,
rendering preferences, the USB protocol, and the Mac input backend are unchanged.

## Capture and gesture changes

- Read `UIEvent.coalescedTouches(for:)` for accepted direct finger contacts,
  falling back to the original touch when no history/current endpoint exists.
- Assign every historical sample its original contact's ID. Sort across contacts
  by capture timestamp and group simultaneous positions into one movement update.
  A stationary finger retains its last measured position; no future position,
  interpolated sample, or predicted motion is introduced.
- Ignore duplicate endpoints and stale timestamps. Contact-count boundaries
  rebase held-finger positions and discard pre-boundary history. Mode/mapping/
  geometry cancellation clears the timeline alongside gesture cancellation.
- Feed the existing Mac acceleration and momentum algorithms source timestamps
  from each sample, independently of callback or packet arrival timing.
- Retain initial two-finger movement until the scroll threshold is crossed.
  Previously the amount discarded depended on sample density; one 10-point
  update and five 2-point updates now both produce 10 points of direct scrolling.
- Continue ignoring lift-location noise and blocking remaining-finger motion
  after a multi-finger gesture. Tap slop considers the entire sampled path,
  including an excursion that returns before the callback's final position.

Apple documents that touch measurements can outnumber app callbacks and that
the extra positions are available via [coalesced touches](https://developer.apple.com/documentation/uikit/getting-high-fidelity-input-with-coalesced-touches).
This improves fidelity where the hardware and OS provide additional samples;
it does not turn batched samples into independently timed callbacks or guarantee
a particular polling rate, visible smoothness, or latency reduction.

## Local measurement

The mobile capture view maintains bounded timing-only metrics: callback and
sample-frame counts, callbacks containing multiple sample frames, batch size,
moving callback/sample intervals, sample age at callback entry, and capture/
gesture/encoding-enqueue processing duration. Simultaneous two-finger positions
count as one sample frame, so touching with two fingers cannot alone double the
reported temporal density. A frame here is a timestamp group, not a display frame.

Each timing window retains at most 512 values. Contact transitions and gaps over
150 ms are excluded from cadence intervals. Counts cover the current capture
view's lifetime; interval percentiles describe the recent retained samples.
After a finger lift, at most once per second, a serial utility queue calculates
percentiles and atomically writes `Documents/finger-input-diagnostics.json` in
the app container. No coordinates, contact identities, keys, or drawing content
are saved. Disk writes, encoding, and percentile sorting run off the input thread.

For a connected development device, retrieve the file with:

```sh
xcrun devicectl device copy from --device '<device identifier>' \
  --domain-type appDataContainer --domain-identifier com.veezee.trackpad \
  --source Documents/finger-input-diagnostics.json \
  --destination /tmp/trackpad-finger-input.json
```

Sample-age measurements use the iPad's uptime clock only. They do not measure
USB one-way delay or physical movement-to-visible-cursor latency. Reciprocal
median intervals describe observed moving cadence, not guaranteed hardware rates.

## Validation

All 50 Swift tests pass, including eight new sampling tests: chronological
multi-touch grouping, duplicate/stale/invalid rejection, excursion-return tap
suppression, scroll-distance conservation, unequal histories/stationary fingers,
contact-count rebasing and partial-lift blocking, identical Mac acceleration/
momentum under different batching, and bounded metrics with distinct callback
and sample cadence. The 60/240 Hz fixture is synthetic, not a device measurement.

The signed iOS Release build and strict bundle-signature verification pass.
The app installed and launched on the physical iPad Air M3, then automatically
reconnected with Mac control enabled.

## Physical finger trial

After the requested slow movement/fast sweeps, scrolling/flicks, taps, and drag
trial, the user reported **“Seems a bit better.”** This is subjective positive
feedback, not a separate confirmation of every gesture or interruption case.

The physical iPad Air M3 diagnostic snapshot at 2026-09-23 06:02:03 UTC contains:

| Measurement | Result |
| --- | --- |
| Movement callbacks | 1,925 |
| Delivered sample timestamp groups | 3,687 (1.92 per callback) |
| Callbacks with extra sample groups | 1,743 (90.5%) |
| Maximum sample groups in one callback | 6 |
| Median callback interval | 16.660 ms, approximately 60 Hz |
| Median sample interval | 8.335 ms, approximately 120 Hz |
| Capture/gesture/encode-enqueue processing | median 0.118 ms; p95 0.177 ms |
| Newest sample age at callback entry | median 0.441 ms; p95 9.081 ms |
| Oldest sample age at callback entry | median 8.751 ms; p95 9.134 ms |

Counts cover the capture view's lifetime, and each timing percentile covers
its latest 512 retained observations. These results demonstrate that the app
now processes additional real finger measurements: typical sample spacing is
about 120 Hz while UIKit still delivers callbacks around 60 Hz. It does not
mean independent 120 Hz callbacks or evenly spaced Mac event presentation.
Extra positions arrive in batches; USB, Mac posting, target-app rendering, and
display latency are not included in the processing measurement. No before/after
physical end-to-end latency measurement was made.

The raw timing-only snapshot is retained under ignored
`.local/measurements/2026-09-23-finger-input.json`.
