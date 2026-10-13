// better-auth addresses its models and fields in camelCase; Buttery's tables are
// snake_case (migration 1791914287248_add_mcp_oauth_tables). Each model below
// lists its better-auth fields once and derives the column names, so the two
// can't drift apart by hand-typing.

const snake = (name: string): string => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

// `requirePKCE` would snake to `require_p_k_c_e`.
const COLUMN_OVERRIDES: Record<string, string> = { requirePKCE: "require_pkce" };

function model(modelName: string, fields: readonly string[]) {
  return { modelName, fields: Object.fromEntries(fields.map((field) => [field, COLUMN_OVERRIDES[field] ?? snake(field)])) };
}

export const jwtSchema = {
  jwks: model("jwks", ["publicKey", "privateKey", "createdAt", "expiresAt"]),
};

export const oauthSchema = {
  oauthClient: model("oauth_client", [
    "clientId",
    "clientSecret",
    "clientDiscoveryId",
    "skipConsent",
    "enableEndSession",
    "subjectType",
    "clientCredentialsScopes",
    "userId",
    "createdAt",
    "updatedAt",
    "softwareId",
    "softwareVersion",
    "softwareStatement",
    "redirectUris",
    "postLogoutRedirectUris",
    "backchannelLogoutUri",
    "backchannelLogoutSessionRequired",
    "tokenEndpointAuthMethod",
    "applicationType",
    "jwksUri",
    "grantTypes",
    "responseTypes",
    "requirePKCE",
    "dpopBoundAccessTokens",
    "referenceId",
  ]),
  oauthResource: model("oauth_resource", [
    "accessTokenTtl",
    "refreshTokenTtl",
    "signingAlgorithm",
    "signingKeyId",
    "allowedScopes",
    "customClaims",
    "dpopBoundAccessTokensRequired",
    "createdAt",
    "updatedAt",
    "policyVersion",
  ]),
  oauthClientResource: model("oauth_client_resource", ["clientId", "resourceId", "createdAt"]),
  oauthRefreshToken: model("oauth_refresh_token", [
    "clientId",
    "sessionId",
    "userId",
    "referenceId",
    "authorizationCodeId",
    "requestedUserInfoClaims",
    "expiresAt",
    "createdAt",
    "rotatedAt",
    "rotationReplayResponse",
    "rotationReplayExpiresAt",
    "authTime",
  ]),
  oauthAccessToken: model("oauth_access_token", [
    "clientId",
    "sessionId",
    "userId",
    "referenceId",
    "authorizationCodeId",
    "requestedUserInfoClaims",
    "refreshId",
    "expiresAt",
    "createdAt",
  ]),
  oauthConsent: model("oauth_consent", ["clientId", "userId", "referenceId", "requestedUserInfoClaims", "createdAt", "updatedAt"]),
  oauthClientAssertion: model("oauth_client_assertion", ["expiresAt"]),
};
