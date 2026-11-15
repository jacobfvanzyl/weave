//! MessagePack (<https://github.com/msgpack/msgpack/blob/master/spec.md>), the encoding of
//! Neovim's RPC: every format, read and written, with no schema. Public for the Host's tests,
//! whose fake Neovim speaks it.

/// How deeply arrays and maps may nest in what's read.
const MAX_DEPTH: usize = 64;

/// A MessagePack value. Strings that aren't UTF-8, as a file name may be, are read lossily.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Nil,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    Bin(Vec<u8>),
    Array(Vec<Value>),
    Map(Vec<(Value, Value)>),
    /// An extension type, as Neovim sends buffer, window and tab page handles.
    Ext(i8, Vec<u8>),
}

impl Value {
    pub fn str(text: impl Into<String>) -> Self {
        Self::Str(text.into())
    }

    /// A map with string keys.
    pub fn map<'a>(entries: impl IntoIterator<Item = (&'a str, Value)>) -> Self {
        Self::Map(
            entries
                .into_iter()
                .map(|(key, value)| (Self::str(key), value))
                .collect(),
        )
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Str(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Int(number) => Some(*number),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Self::Array(items) => Some(items),
            _ => None,
        }
    }

    /// The value at the string key `key` of a map.
    pub fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Self::Map(entries) => entries
                .iter()
                .find(|(name, _)| name.as_str() == Some(key))
                .map(|(_, value)| value),
            _ => None,
        }
    }
}

/// What was read isn't MessagePack, or nests too deeply.
#[derive(Debug, PartialEq, Eq)]
pub struct Malformed(pub String);

impl std::fmt::Display for Malformed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "malformed MessagePack: {}", self.0)
    }
}

/// `value`, appended to `out`, each part in its smallest format.
pub fn encode(value: &Value, out: &mut Vec<u8>) {
    match value {
        Value::Nil => out.push(0xc0),
        Value::Bool(false) => out.push(0xc2),
        Value::Bool(true) => out.push(0xc3),
        Value::Int(number) => encode_int(*number, out),
        Value::Float(number) => {
            out.push(0xcb);
            out.extend_from_slice(&number.to_be_bytes());
        }
        Value::Str(text) => {
            let len = text.len();
            match len {
                0..=31 => out.push(0xa0 | len as u8),
                32..=0xff => out.extend_from_slice(&[0xd9, len as u8]),
                _ => length(0xda, 0xdb, len, out),
            }
            out.extend_from_slice(text.as_bytes());
        }
        Value::Bin(bytes) => {
            let len = bytes.len();
            match len {
                0..=0xff => out.extend_from_slice(&[0xc4, len as u8]),
                _ => length(0xc5, 0xc6, len, out),
            }
            out.extend_from_slice(bytes);
        }
        Value::Array(items) => {
            let len = items.len();
            match len {
                0..=15 => out.push(0x90 | len as u8),
                _ => length(0xdc, 0xdd, len, out),
            }
            for item in items {
                encode(item, out);
            }
        }
        Value::Map(entries) => {
            let len = entries.len();
            match len {
                0..=15 => out.push(0x80 | len as u8),
                _ => length(0xde, 0xdf, len, out),
            }
            for (key, value) in entries {
                encode(key, out);
                encode(value, out);
            }
        }
        Value::Ext(kind, data) => {
            let len = data.len();
            match len {
                1 => out.push(0xd4),
                2 => out.push(0xd5),
                4 => out.push(0xd6),
                8 => out.push(0xd7),
                16 => out.push(0xd8),
                0..=0xff => out.extend_from_slice(&[0xc7, len as u8]),
                _ => length(0xc8, 0xc9, len, out),
            }
            out.push(*kind as u8);
            out.extend_from_slice(data);
        }
    }
}

fn encode_int(number: i64, out: &mut Vec<u8>) {
    match number {
        0..=0x7f => out.push(number as u8),
        -32..=-1 => out.push(number as u8),
        0x80..=0xff => out.extend_from_slice(&[0xcc, number as u8]),
        0x100..=0xffff => {
            out.push(0xcd);
            out.extend_from_slice(&(number as u16).to_be_bytes());
        }
        0x1_0000..=0xffff_ffff => {
            out.push(0xce);
            out.extend_from_slice(&(number as u32).to_be_bytes());
        }
        0x1_0000_0000.. => {
            out.push(0xcf);
            out.extend_from_slice(&(number as u64).to_be_bytes());
        }
        -0x80..=-33 => out.extend_from_slice(&[0xd0, number as i8 as u8]),
        -0x8000..=-0x81 => {
            out.push(0xd1);
            out.extend_from_slice(&(number as i16).to_be_bytes());
        }
        -0x8000_0000..=-0x8001 => {
            out.push(0xd2);
            out.extend_from_slice(&(number as i32).to_be_bytes());
        }
        _ => {
            out.push(0xd3);
            out.extend_from_slice(&number.to_be_bytes());
        }
    }
}

/// A length as 16 bits after `short`, else 32 after `long`. Longer isn't MessagePack, and
/// nothing the Host sends comes near it.
fn length(short: u8, long: u8, len: usize, out: &mut Vec<u8>) {
    match u16::try_from(len) {
        Ok(len) => {
            out.push(short);
            out.extend_from_slice(&len.to_be_bytes());
        }
        Err(_) => {
            out.push(long);
            out.extend_from_slice(&u32::try_from(len).unwrap_or(u32::MAX).to_be_bytes());
        }
    }
}

/// The first value in `bytes` and how many bytes it took; none while it's incomplete.
pub fn decode(bytes: &[u8]) -> Result<Option<(Value, usize)>, Malformed> {
    let mut reader = Reader { bytes, at: 0 };
    match reader.value(0) {
        Ok(value) => Ok(Some((value, reader.at))),
        Err(Short::Incomplete) => Ok(None),
        Err(Short::Malformed(why)) => Err(Malformed(why)),
    }
}

enum Short {
    Incomplete,
    Malformed(String),
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take(&mut self, len: usize) -> Result<&[u8], Short> {
        let end = self.at.checked_add(len).ok_or(Short::Incomplete)?;
        let taken = self.bytes.get(self.at..end).ok_or(Short::Incomplete)?;
        self.at = end;
        Ok(taken)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], Short> {
        let mut array = [0; N];
        array.copy_from_slice(self.take(N)?);
        Ok(array)
    }

    fn byte(&mut self) -> Result<u8, Short> {
        Ok(self.array::<1>()?[0])
    }

    fn len(&mut self, bytes: usize) -> Result<usize, Short> {
        Ok(match bytes {
            1 => usize::from(self.byte()?),
            2 => usize::from(u16::from_be_bytes(self.array()?)),
            _ => u32::from_be_bytes(self.array()?) as usize,
        })
    }

    fn string(&mut self, len: usize) -> Result<Value, Short> {
        Ok(Value::Str(
            String::from_utf8_lossy(self.take(len)?).into_owned(),
        ))
    }

    fn items(&mut self, len: usize, depth: usize) -> Result<Value, Short> {
        // Never more than the bytes left, whatever the length says.
        let mut items = Vec::with_capacity(len.min(self.bytes.len() - self.at));
        for _ in 0..len {
            items.push(self.value(depth + 1)?);
        }
        Ok(Value::Array(items))
    }

    fn entries(&mut self, len: usize, depth: usize) -> Result<Value, Short> {
        let mut entries = Vec::with_capacity(len.min(self.bytes.len() - self.at));
        for _ in 0..len {
            let key = self.value(depth + 1)?;
            entries.push((key, self.value(depth + 1)?));
        }
        Ok(Value::Map(entries))
    }

    fn ext(&mut self, len: usize) -> Result<Value, Short> {
        let kind = self.byte()? as i8;
        Ok(Value::Ext(kind, self.take(len)?.to_vec()))
    }

    fn value(&mut self, depth: usize) -> Result<Value, Short> {
        if depth > MAX_DEPTH {
            return Err(Short::Malformed(format!(
                "nested more than {MAX_DEPTH} deep"
            )));
        }
        let marker = self.byte()?;
        Ok(match marker {
            0x00..=0x7f => Value::Int(i64::from(marker)),
            0x80..=0x8f => self.entries(usize::from(marker & 0x0f), depth)?,
            0x90..=0x9f => self.items(usize::from(marker & 0x0f), depth)?,
            0xa0..=0xbf => self.string(usize::from(marker & 0x1f))?,
            0xc0 => Value::Nil,
            0xc2 => Value::Bool(false),
            0xc3 => Value::Bool(true),
            0xc4..=0xc6 => {
                let len = self.len(1 << (marker - 0xc4))?;
                Value::Bin(self.take(len)?.to_vec())
            }
            0xc7..=0xc9 => {
                let len = self.len(1 << (marker - 0xc7))?;
                self.ext(len)?
            }
            0xca => Value::Float(f64::from(f32::from_be_bytes(self.array()?))),
            0xcb => Value::Float(f64::from_be_bytes(self.array()?)),
            0xcc => Value::Int(i64::from(self.byte()?)),
            0xcd => Value::Int(i64::from(u16::from_be_bytes(self.array()?))),
            0xce => Value::Int(i64::from(u32::from_be_bytes(self.array()?))),
            0xcf => {
                let number = u64::from_be_bytes(self.array()?);
                Value::Int(i64::try_from(number).map_err(|_| {
                    Short::Malformed(format!("{number} is larger than the Host reads"))
                })?)
            }
            0xd0 => Value::Int(i64::from(self.byte()? as i8)),
            0xd1 => Value::Int(i64::from(i16::from_be_bytes(self.array()?))),
            0xd2 => Value::Int(i64::from(i32::from_be_bytes(self.array()?))),
            0xd3 => Value::Int(i64::from_be_bytes(self.array()?)),
            0xd4..=0xd8 => self.ext(1 << (marker - 0xd4))?,
            0xd9..=0xdb => {
                let len = self.len(1 << (marker - 0xd9))?;
                self.string(len)?
            }
            0xdc | 0xdd => {
                let len = self.len(2 << (marker - 0xdc))?;
                self.items(len, depth)?
            }
            0xde | 0xdf => {
                let len = self.len(2 << (marker - 0xde))?;
                self.entries(len, depth)?
            }
            0xe0..=0xff => Value::Int(i64::from(marker as i8)),
            0xc1 => return Err(Short::Malformed("the reserved marker 0xc1".to_owned())),
        })
    }
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;

    use super::*;

    fn encoded(value: &Value) -> Vec<u8> {
        let mut out = Vec::new();
        encode(value, &mut out);
        out
    }

    #[test]
    fn every_format_reads_back_as_written() {
        let long = "x".repeat(300);
        let values = [
            Value::Nil,
            Value::Bool(true),
            Value::Bool(false),
            Value::Int(0),
            Value::Int(127),
            Value::Int(128),
            Value::Int(65_535),
            Value::Int(65_536),
            Value::Int(5_000_000_000),
            Value::Int(-1),
            Value::Int(-32),
            Value::Int(-33),
            Value::Int(-200),
            Value::Int(-40_000),
            Value::Int(-5_000_000_000),
            Value::Float(1.5),
            Value::str(""),
            Value::str("é"),
            Value::str("x".repeat(40)),
            Value::str(long),
            Value::Bin(vec![1, 2, 3]),
            Value::Bin(vec![7; 300]),
            Value::Array((0..20).map(Value::Int).collect()),
            Value::map([("a", Value::Nil), ("b", Value::Array(vec![]))]),
            Value::Map((0..20).map(|n| (Value::Int(n), Value::Int(n))).collect()),
            Value::Ext(0, vec![1]),
            Value::Ext(1, vec![1, 2, 3]),
            Value::Ext(2, vec![9; 300]),
        ];
        for value in values {
            let bytes = encoded(&value);
            assert_eq!(decode(&bytes), Ok(Some((value, bytes.len()))));
        }
    }

    #[test]
    fn integers_take_their_smallest_format() {
        assert_eq!(encoded(&Value::Int(5)), [0x05]);
        assert_eq!(encoded(&Value::Int(-5)), [0xfb]);
        assert_eq!(encoded(&Value::Int(200)), [0xcc, 200]);
        assert_eq!(encoded(&Value::Int(-100)), [0xd0, 0x9c]);
        assert_eq!(encoded(&Value::str("ab")), [0xa2, b'a', b'b']);
    }

    #[test]
    fn what_other_encoders_write_is_read_too() {
        // A 32-bit float, and Neovim's buffer handle: ext 0 with a fixint inside.
        assert_eq!(
            decode(&[0xca, 0x3f, 0xc0, 0, 0]),
            Ok(Some((Value::Float(1.5), 5)))
        );
        assert_eq!(
            decode(&[0xd4, 0x00, 0x01]),
            Ok(Some((Value::Ext(0, vec![1]), 3)))
        );
        assert_eq!(
            decode(&[0xa2, 0xff, b'a']),
            Ok(Some((Value::str("\u{fffd}a"), 3)))
        );
    }

    #[test]
    fn an_incomplete_value_waits_and_what_follows_is_left() {
        let bytes = encoded(&Value::Array(vec![Value::str("hello"), Value::Int(1)]));
        for end in 0..bytes.len() {
            assert_eq!(decode(&bytes[..end]), Ok(None), "{end} bytes");
        }
        let mut two = bytes.clone();
        two.push(0xc0);
        assert_eq!(
            decode(&two).map(|read| read.map(|(_, len)| len)),
            Ok(Some(bytes.len()))
        );
        // A length longer than what's there is incomplete, not allocated.
        assert_eq!(decode(&[0xdd, 0xff, 0xff, 0xff, 0xff]), Ok(None));
    }

    #[test]
    fn whats_not_messagepack_is_refused() {
        assert!(decode(&[0xc1]).is_err());
        assert!(decode(&[0xcf, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]).is_err());
        let deep = vec![0x91; MAX_DEPTH + 2];
        assert!(decode(&deep).is_err());
    }
}
