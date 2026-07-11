export const WEAVE_CREDENTIAL_OWNER_HEADER = 'x-weave-credential-owner-id';

export const credentialOwnerHeaders = (
  ownerId: string,
  headers?: Record<string, string>,
): Record<string, string> => ({
  ...headers,
  [WEAVE_CREDENTIAL_OWNER_HEADER]: encodeURIComponent(ownerId),
});
