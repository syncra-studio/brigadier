use super::Event;

/// Whether a failed turn's cause passes by itself: busy servers, a dropped connection, a request
/// that timed out. Every other failure is final at once; no retry of ours either way [D340, D496].
pub fn temporary(why: &str) -> bool {
    matches!(why, "capacity" | "connection" | "timeout")
}

/// Classifies an error message the way every backend needs: a full context, no credits, a limit,
/// a sign-in, busy servers, a timeout, a dropped connection, or none of them.
pub fn classify(message: &str) -> Option<Event> {
    let m = message.to_lowercase();
    // With its own compaction off, a CLI's turn fails once the window is full [D98].
    let full = [
        "prompt is too long",
        "context_length_exceeded",
        "maximum context length",
        "context window",
    ];
    if full.iter().any(|k| m.contains(k)) {
        return Some(Event::Failed("context", message.to_string()));
    }
    let credits = [
        "insufficient account funds",
        "insufficient funds",
        "insufficient credit",
        "insufficient_quota",
        "credit balance",
        "out of credits",
        "billing_error",
        "payment required",
    ];
    if credits.iter().any(|k| m.contains(k)) {
        return Some(Event::OutOfCredits);
    }
    let limit = [
        "429",
        "rate limit",
        "rate_limit",
        "usage limit",
        "quota",
        "too many requests",
    ];
    let auth = [
        "401",
        "403",
        "unauthorized",
        "login",
        "log in",
        "sign in",
        "expired",
        "invalid api key",
        "authentication",
    ];
    if limit.iter().any(|k| m.contains(k)) {
        Some(Event::Limited(message.to_string(), None))
    } else if auth.iter().any(|k| m.contains(k)) {
        Some(Event::SignIn(message.to_string()))
    } else {
        let busy = ["overloaded", "529", "503", "at capacity", "high demand"];
        let late = ["timed out", "timeout", "deadline exceeded"];
        let dropped = [
            "connection error",
            "connection reset",
            "connection refused",
            "connection closed",
            "connection failed",
            "network error",
            "econnreset",
            "econnrefused",
            "socket hang up",
            "stream disconnected",
        ];
        let why = [
            ("capacity", &busy[..]),
            ("timeout", &late),
            ("connection", &dropped),
        ]
        .into_iter()
        .find(|(_, words)| words.iter().any(|k| m.contains(k)))?
        .0;
        Some(Event::Failed(why, message.to_string()))
    }
}
