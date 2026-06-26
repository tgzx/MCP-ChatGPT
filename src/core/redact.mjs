export function redactSensitiveText(value) {
  return String(value || "")
    .replace(/([?&](?:access_token|id_token|refresh_token|token|sid|session|code|frontdoor|otp|cshc)[^=]*=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
}

export function redactSensitiveObject(value) {
  if (Array.isArray(value)) {
    return value.map(item => redactSensitiveObject(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactSensitiveObject(item)])
    );
  }

  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  return value;
}
