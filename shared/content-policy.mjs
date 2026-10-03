// What the voice page may load and reach: its own files, and ElevenLabs for the conversation.
// The local server sends this as a header.
export const CONTENT_SECURITY_HEADER = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' https://api.elevenlabs.io wss://api.elevenlabs.io https://livekit.rtc.elevenlabs.io wss://livekit.rtc.elevenlabs.io; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

// A static host sends no such header, so that build carries the policy in the
// page. A policy written there cannot speak about framing; the rest is the same.
export const CONTENT_SECURITY_POLICY = CONTENT_SECURITY_HEADER.replace("frame-ancestors 'none'; ", '');
