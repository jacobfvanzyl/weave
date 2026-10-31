//! A P-256 key in the Secure Enclave of the Mac this runs on, for a Host proving itself to its
//! peers (ADR 0017): its private key can't be copied off the computer.
//!
//! The key isn't kept in a keychain, which an unsigned binary rebuilt often can't use: the
//! Security framework makes it without one and gives its wrapped form (`toid`), which only this
//! computer's Secure Enclave can use, to save in a file and hand back later through
//! `SecKeyCreateWithData`, as CryptoKit's `dataRepresentation` does. That works for an ad-hoc
//! signed binary under launchd, as the Host is; checked on 2026-10-30 with a rebuilt binary in
//! launchd's `gui/` domain.

use core_foundation::base::TCFType;
use core_foundation::data::CFData;
use core_foundation::dictionary::CFDictionary;
use core_foundation::error::CFError;
use core_foundation::string::CFString;
use security_framework::key::Algorithm;
use security_framework::key::GenerateKeyOptions;
use security_framework::key::KeyType;
use security_framework::key::SecKey;
use security_framework::key::Token;
use security_framework_sys::item::kSecAttrKeyClass;
use security_framework_sys::item::kSecAttrKeyClassPrivate;
use security_framework_sys::item::kSecAttrKeyType;
use security_framework_sys::item::kSecAttrKeyTypeECSECPrimeRandom;
use security_framework_sys::item::kSecAttrTokenID;
use security_framework_sys::item::kSecAttrTokenIDSecureEnclave;
use security_framework_sys::key::SecKeyCreateWithData;

/// The attribute that holds a Secure Enclave key's wrapped form: `kSecAttrTokenOID`, which the
/// Security framework's Rust bindings don't name.
const TOKEN_OID: &str = "toid";

/// A key in the Secure Enclave, with its wrapped form and its public key.
#[derive(Clone)]
pub(crate) struct EnclaveKey {
    key: SecKey,
    wrapped: Vec<u8>,
    /// The public key as X9.63: `04`, then x and y.
    public: Vec<u8>,
}

impl EnclaveKey {
    /// A new key, made in the Secure Enclave. Fails on a Mac without one.
    pub(crate) fn generate() -> Result<Self, String> {
        let mut options = GenerateKeyOptions::default();
        options
            .set_key_type(KeyType::ec_sec_prime_random())
            .set_size_in_bits(256)
            .set_token(Token::SecureEnclave);
        let key = SecKey::new(&options).map_err(|error| describe(&error))?;
        let attributes = key.attributes();
        let token_oid = CFString::from_static_string(TOKEN_OID);
        let wrapped = attributes
            .find(token_oid.as_CFTypeRef())
            // SAFETY: the attribute is a CFData, borrowed from the dictionary, which retains it.
            .map(|value| unsafe { CFData::wrap_under_get_rule(value.cast()) }.to_vec())
            .ok_or("the Secure Enclave gave no wrapped key")?;
        Self::with(key, wrapped)
    }

    /// The key whose wrapped form [`Self::wrapped`] gave.
    pub(crate) fn from_wrapped(wrapped: &[u8]) -> Result<Self, String> {
        let data = CFData::from_buffer(wrapped);
        // The wrapped key goes in the attributes too: without it the Secure Enclave makes a new
        // key rather than taking this one back.
        // SAFETY: the attribute names and values are the Security framework's own constants.
        let attributes = unsafe {
            CFDictionary::from_CFType_pairs(&[
                (
                    CFString::wrap_under_get_rule(kSecAttrKeyType),
                    CFString::wrap_under_get_rule(kSecAttrKeyTypeECSECPrimeRandom).as_CFType(),
                ),
                (
                    CFString::wrap_under_get_rule(kSecAttrKeyClass),
                    CFString::wrap_under_get_rule(kSecAttrKeyClassPrivate).as_CFType(),
                ),
                (
                    CFString::wrap_under_get_rule(kSecAttrTokenID),
                    CFString::wrap_under_get_rule(kSecAttrTokenIDSecureEnclave).as_CFType(),
                ),
                (CFString::from_static_string(TOKEN_OID), data.as_CFType()),
            ])
        };
        let mut error = std::ptr::null_mut();
        // SAFETY: both arguments are live CF objects, and the error is ours to release.
        let key = unsafe {
            SecKeyCreateWithData(
                data.as_concrete_TypeRef(),
                attributes.as_concrete_TypeRef(),
                &mut error,
            )
        };
        if key.is_null() {
            if error.is_null() {
                return Err("the Secure Enclave didn't take the key back".to_owned());
            }
            // SAFETY: a non-null error from a Create function is ours.
            return Err(describe(&unsafe { CFError::wrap_under_create_rule(error) }));
        }
        // SAFETY: a non-null key from a Create function is ours.
        let key = unsafe { SecKey::wrap_under_create_rule(key) };
        Self::with(key, wrapped.to_vec())
    }

    fn with(key: SecKey, wrapped: Vec<u8>) -> Result<Self, String> {
        let public = key
            .public_key()
            .and_then(|public| public.external_representation())
            .map(|data| data.to_vec())
            .filter(|bytes| bytes.len() == 65 && bytes[0] == 4)
            .ok_or("the Secure Enclave key has no P-256 public key")?;
        Ok(Self {
            key,
            wrapped,
            public,
        })
    }

    /// The wrapped key, to save: only this computer's Secure Enclave can use it.
    pub(crate) fn wrapped(&self) -> &[u8] {
        &self.wrapped
    }

    /// The public key's coordinates, 32 bytes each.
    pub(crate) fn coordinates(&self) -> (&[u8], &[u8]) {
        (&self.public[1..33], &self.public[33..65])
    }

    /// `message`'s ECDSA P-256 SHA-256 signature, DER-encoded.
    pub(crate) fn sign(&self, message: &[u8]) -> Result<Vec<u8>, String> {
        self.key
            .create_signature(Algorithm::ECDSASignatureMessageX962SHA256, message)
            .map_err(|error| describe(&error))
    }
}

fn describe(error: &CFError) -> String {
    error.description().to_string()
}
