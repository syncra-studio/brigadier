use super::Event;

/// Classifies an error message the way every backend needs: no credits, a limit, a sign-in, or
/// neither.
pub fn classify(message: &str) -> Option<Event> {
    let m = message.to_lowercase();
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
        None
    }
}
