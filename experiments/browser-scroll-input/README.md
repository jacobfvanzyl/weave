# Native wheel input probe

WVE-79, Mac-only, 2026-09-13. The bounded whole-pixel probe in
`native-wheel.patch` established that CEF's upstream `SendMouseWheelEvent`
could remove the DevTools wheel acknowledgment bottleneck. With the coalescing
client it measured 59.9 distinct scrolling updates/s for 60 seconds at
1147 × 849 over Portal's authenticated loopback WebSocket route.

The patch required `WEAVE_BROWSER_EXPERIMENT_NATIVE_WHEEL=1` and only handled
integer deltas. It is historical evidence, not a product configuration switch.
The product adapter supersedes it with fractional accumulation and an optional
private human-input hint; agent CDP remains unchanged. The probe's 77 ms software
latency p95 was better than subsequent product runs and must not be presented as
the final product's latency.

See the [implementation report](../../docs/research/wve-79/mac-scrolling-implementation.md)
for the final comparisons, correctness checks and remaining gates. The patch is
relative to the instrumented pre-native-input source and is not intended to apply
on top of the superseding product implementation.
