//! The holder protocol on a holder's Unix socket (`docs/specs/wve-85-host-protocol.md`,
//! "Holders").
//!
//! Each frame is a big-endian u32 length of what follows, a kind byte, then the payload:
//!
//! | Kind | Direction | Payload |
//! | --- | --- | --- |
//! | `0x00` | both | One JSON message: a request, an answer or an event |
//! | `0x01` | holder to client | A snapshot, in chunks; the decoder finds its ready prefix and history pages |
//! | `0x03` | holder to client | Output: the program's bytes, unchanged |
//! | `0x10` | client to holder | Input: bytes as typed |
//!
//! The kinds are the terminal stream's, so the Host passes snapshot, output and input frames on
//! without opening them. JSON follows Rex's server API: `{"id", "method", "args"}` asks,
//! `{"id", "result"}` or `{"id", "error": {"code", "message"}}` answers, with Rex's codes
//! `bad_request` and `method_not_found`, and events are `{"type", "payload"}` (`event.rs`).

use std::io;
use std::io::Read;
use std::io::Write;

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

pub const JSON: u8 = 0x00;
pub const SNAPSHOT: u8 = 0x01;
pub const OUTPUT: u8 = 0x03;
pub const INPUT: u8 = 0x10;

/// The holder protocol's version, said in `hello`. A Host speaks the version of every holder
/// still running.
pub const PROTOCOL: u32 = 1;

/// The largest frame either side accepts, so a corrupt length can't ask for gigabytes.
pub const MAX_FRAME: usize = 16 * 1024 * 1024;

/// A snapshot goes out in chunks of this size.
pub const SNAPSHOT_CHUNK: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
pub struct Request {
    #[serde(default)]
    pub id: Value,
    pub method: String,
    #[serde(default)]
    pub args: Value,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Answer {
    Result { id: Value, result: Value },
    Error { id: Value, error: Failure },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Failure {
    pub code: Code,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Code {
    BadRequest,
    MethodNotFound,
}

impl Failure {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            code: Code::BadRequest,
            message: message.into(),
        }
    }
}

/// A frame of `kind` around `payload`.
pub fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(5 + payload.len());
    let len = u32::try_from(payload.len() + 1).unwrap_or(u32::MAX);
    frame.extend_from_slice(&len.to_be_bytes());
    frame.push(kind);
    frame.extend_from_slice(payload);
    frame
}

/// A JSON frame.
pub fn json(value: &impl Serialize) -> Vec<u8> {
    frame(JSON, &serde_json::to_vec(value).unwrap_or_default())
}

/// The next frame's kind and payload, or None at the end of the stream.
pub fn read_frame(reader: &mut impl Read) -> io::Result<Option<(u8, Vec<u8>)>> {
    let mut len = [0; 4];
    match reader.read_exact(&mut len) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let len = u32::from_be_bytes(len) as usize;
    if len == 0 || len > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("a frame of {len} bytes"),
        ));
    }
    let mut payload = vec![0; len];
    reader.read_exact(&mut payload)?;
    let kind = payload.remove(0);
    Ok(Some((kind, payload)))
}

pub fn write_frame(writer: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    writer.write_all(&frame(kind, payload))
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use serde_json::json;

    use super::*;

    #[test]
    fn frames_round_trip() {
        let mut bytes = frame(OUTPUT, b"hi");
        bytes.extend(json(&json!({"id": 1, "method": "describe"})));
        assert_eq!(&bytes[..7], &[0, 0, 0, 3, OUTPUT, b'h', b'i']);
        let mut reader = bytes.as_slice();
        assert_eq!(
            read_frame(&mut reader).unwrap(),
            Some((OUTPUT, b"hi".to_vec()))
        );
        let (kind, payload) = read_frame(&mut reader).unwrap().unwrap();
        assert_eq!(kind, JSON);
        let request: Request = serde_json::from_slice(&payload).unwrap();
        assert_eq!((request.id, request.method), (json!(1), "describe".into()));
        assert_eq!(read_frame(&mut reader).unwrap(), None);
    }

    #[test]
    fn refuses_frames_too_large_or_empty() {
        for len in [0u32, MAX_FRAME as u32 + 1] {
            let bytes = len.to_be_bytes();
            assert!(read_frame(&mut bytes.as_slice()).is_err());
        }
    }

    #[test]
    fn answers_are_rexs() {
        let answer = Answer::Error {
            id: json!(3),
            error: Failure {
                code: Code::MethodNotFound,
                message: "no method frob".into(),
            },
        };
        assert_eq!(
            serde_json::to_value(answer).unwrap(),
            json!({"id": 3, "error": {"code": "method_not_found", "message": "no method frob"}})
        );
    }
}
