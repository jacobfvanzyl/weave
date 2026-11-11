//! Times, as the protocol gives them, and how long ago they were; times in a time zone, as the
//! Dispatcher describes them, and as the command line gives them; and durations.

use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use anyhow::Context as _;
use anyhow::anyhow;
use jiff::Timestamp;
use jiff::Zoned;
use jiff::civil::DateTime;
use jiff::tz::TimeZone;

pub(crate) fn ago(now_ms: u64, then_ms: u64) -> String {
    let seconds = now_ms.saturating_sub(then_ms) / 1000;
    match seconds {
        0..60 => format!("{seconds}s"),
        60..3600 => format!("{}m", seconds / 60),
        3600..86400 => format!("{}h", seconds / 3600),
        _ => format!("{}d", seconds / 86400),
    }
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// The IANA time zone `name` names.
pub(crate) fn zone(name: &str) -> anyhow::Result<TimeZone> {
    TimeZone::get(name).map_err(|error| anyhow!("the time zone {name:?}: {error}"))
}

/// This computer's time zone, by its IANA name, when it has one.
pub(crate) fn local_zone() -> Option<String> {
    TimeZone::system().iana_name().map(str::to_owned)
}

/// `at` in `zone`, or UTC when that isn't one.
fn zoned(at: u64, zone_name: &str) -> Option<Zoned> {
    let at = Timestamp::from_millisecond(i64::try_from(at).ok()?).ok()?;
    Some(at.to_zoned(zone(zone_name).unwrap_or(TimeZone::UTC)))
}

/// `at` in `zone`, as the Dispatcher describes a schedule's times but with the year, which a
/// one-off's may be far off in: "Thu 12 Nov 2026 09:00 SAST".
pub(crate) fn describe(at: u64, zone_name: &str) -> String {
    zoned(at, zone_name)
        .map(|zoned| zoned.strftime("%a %-d %b %Y %H:%M %Z").to_string())
        .unwrap_or_default()
}

/// `at`'s date and time in `zone`: "2026-11-04 09:00".
pub(crate) fn stamp(at: u64, zone_name: &str) -> String {
    zoned(at, zone_name)
        .map(|zoned| zoned.strftime("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

/// A time given on the command line, in milliseconds: RFC 3339, such as
/// `2026-11-12T09:00:00+02:00`, or a date and time of day, `2026-11-12 09:00`, in `zone`, or this
/// computer's time zone without one.
pub(crate) fn parse_time(text: &str, zone_name: Option<&str>) -> anyhow::Result<u64> {
    let text = text.trim();
    let at = match text.parse::<Timestamp>() {
        Ok(at) => at,
        Err(_) => {
            let local: DateTime = text.parse().map_err(|_| {
                anyhow!(
                    "{text:?} isn't a time: give one as 2026-11-12 09:00, in --zone or this \
                     computer's time zone, or as 2026-11-12T09:00:00+02:00"
                )
            })?;
            let zone = match zone_name {
                Some(name) => zone(name)?,
                None => TimeZone::system(),
            };
            local
                .to_zoned(zone)
                .with_context(|| format!("{text} in its time zone"))?
                .timestamp()
        }
    };
    u64::try_from(at.as_millisecond()).with_context(|| format!("{text} is before 1970"))
}

/// `ms` as a duration in one unit, as `--pause-after` takes it: "12h", "90m", "45s", "500ms".
pub(crate) fn duration(ms: u64) -> String {
    match ms {
        0 => "0s".to_owned(),
        _ if ms.is_multiple_of(3_600_000) => format!("{}h", ms / 3_600_000),
        _ if ms.is_multiple_of(60_000) => format!("{}m", ms / 60_000),
        _ if ms.is_multiple_of(1000) => format!("{}s", ms / 1000),
        _ => format!("{ms}ms"),
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    #[test]
    fn times_are_read_in_their_zone_and_said_in_it() {
        // 2026-11-12 07:00 UTC.
        let at = 1_794_466_800_000;
        assert_eq!(parse_time("2026-11-12T09:00:00+02:00", None).ok(), Some(at));
        assert_eq!(parse_time("2026-11-12T07:00:00Z", None).ok(), Some(at));
        assert_eq!(
            parse_time("2026-11-12 09:00", Some("Africa/Johannesburg")).ok(),
            Some(at)
        );
        assert_eq!(parse_time(" 2026-11-12 07:00 ", Some("UTC")).ok(), Some(at));
        assert!(parse_time("tomorrow", Some("UTC")).is_err());
        assert!(parse_time("2026-11-12 09:00", Some("Mars/Olympus")).is_err());
        assert_eq!(
            describe(at, "Africa/Johannesburg"),
            "Thu 12 Nov 2026 09:00 SAST"
        );
        assert_eq!(stamp(at, "UTC"), "2026-11-12 07:00");
        // A zone that isn't one says the time in UTC.
        assert_eq!(stamp(at, "nowhere"), "2026-11-12 07:00");
    }

    #[test]
    fn durations_are_said_as_they_are_given() {
        assert_eq!(duration(12 * 3_600_000), "12h");
        assert_eq!(duration(90 * 60_000), "90m");
        assert_eq!(duration(45_000), "45s");
        assert_eq!(duration(1500), "1500ms");
        assert_eq!(duration(0), "0s");
    }
}
