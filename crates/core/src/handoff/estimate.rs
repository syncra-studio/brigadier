//! Tokens, estimated on the safe side, the one measure every hand-off size and the keep list use
//! (rev 2 §4.2): ASCII at 3 bytes a token, a run of 20 or more characters with no space (a hash,
//! base64, a path) at 2, every other character as 2 tokens.

/// The estimated tokens of `s`.
pub fn tokens(s: &str) -> usize {
    // In sixths of a token: an ASCII byte 2, an ASCII byte of a long run 3, any other character 12.
    let cost = |c: char, long: bool| match (c.is_ascii(), long) {
        (false, _) => 12,
        (true, true) => 3,
        (true, false) => 2,
    };
    let mut sixths = 0;
    let mut word = String::new();
    let flush = |word: &mut String, sixths: &mut usize| {
        let long = word.chars().count() >= 20;
        *sixths += word.chars().map(|c| cost(c, long)).sum::<usize>();
        word.clear();
    };
    for c in s.chars() {
        if c.is_whitespace() {
            flush(&mut word, &mut sixths);
            sixths += cost(c, false);
        } else {
            word.push(c);
        }
    }
    flush(&mut word, &mut sixths);
    sixths.div_ceil(6)
}
