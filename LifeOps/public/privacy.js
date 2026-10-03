function containsSensitiveContactData(value) {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value) ||
    /(?:\+91[\s-]?)?[6-9]\d{9}\b/.test(value) ||
    /\b(?:password|passcode|otp|cvv|cvc|upi[\s_-]*pin|pin)\b(?:\s*[:=]\s*|\s+)\S+/i.test(value);
}

if (typeof module === "object" && module.exports) {
  module.exports = containsSensitiveContactData;
} else {
  window.lifeOpsContainsSensitiveContactData = containsSensitiveContactData;
}
